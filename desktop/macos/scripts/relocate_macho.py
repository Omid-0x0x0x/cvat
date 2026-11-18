#!/usr/bin/env python3
"""Make Mach-O binaries self-contained for the CVAT Desktop bundle.

Two sub-commands:

  relocate --lib-dir DIR PATH [PATH...]
      Copy every non-system dynamic library that the Mach-O files under PATH
      depend on (e.g. Homebrew's libldap or libxmlsec1) into DIR, recursively,
      and rewrite the load commands to point at the copies with @loader_path.
      Every modified file is re-signed ad hoc, as required on Apple Silicon.

  verify PATH [PATH...]
      Fail if any Mach-O file under PATH still refers to a library outside the
      system (/usr/lib, /System) by an absolute path. Run this on the final
      bundle: it is what guarantees the app works without Homebrew.
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

MACHO_MAGICS = {
    b"\xcf\xfa\xed\xfe",  # 64-bit little endian (arm64, x86_64)
    b"\xce\xfa\xed\xfe",  # 32-bit little endian
    b"\xca\xfe\xba\xbe",  # universal
    b"\xbe\xba\xfe\xca",
}
SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/")
RELATIVE_PREFIXES = ("@rpath/", "@loader_path/", "@executable_path/")


def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def is_macho(path: Path) -> bool:
    if path.is_symlink() or not path.is_file():
        return False
    try:
        if path.stat().st_size < 4096:
            return False
        with path.open("rb") as handle:
            return handle.read(4) in MACHO_MAGICS
    except OSError:
        return False


def iter_macho(roots):
    for root in roots:
        root = Path(root)
        if root.is_file():
            if is_macho(root):
                yield root
            continue
        for current, dirs, files in os.walk(root):
            dirs.sort()
            for name in sorted(files):
                candidate = Path(current) / name
                if is_macho(candidate):
                    yield candidate


def own_ids(path: Path) -> set:
    lines = run("otool", "-D", str(path)).splitlines()[1:]
    return {line.strip() for line in lines if line.strip()}


def dependencies(path: Path) -> list:
    try:
        own = own_ids(path)
        listing = run("otool", "-L", str(path))
    except subprocess.CalledProcessError:
        return []  # looks like Mach-O by magic number only (e.g. a Java class file)
    result = []
    for line in listing.splitlines()[1:]:
        entry = line.strip().split(" (compatibility", 1)[0].strip()
        if entry and entry not in own and entry not in result:
            result.append(entry)
    return result


def is_external(dependency: str) -> bool:
    if dependency.startswith(RELATIVE_PREFIXES) or dependency.startswith(SYSTEM_PREFIXES):
        return False
    return dependency.startswith("/")


def make_writable(path: Path) -> None:
    path.chmod(path.stat().st_mode | 0o200)


def sign(path: Path) -> None:
    run("codesign", "--force", "--sign", "-", str(path))


def index_bundled_dylibs(roots, lib_dir: Path) -> dict:
    """Map file name -> path for every .dylib already inside the bundle (symlinks included)."""
    index = {}
    for root in list(roots) + [lib_dir]:
        root = Path(root)
        if not root.is_dir():
            continue
        for current, _dirs, files in os.walk(root):
            for name in sorted(files):
                if name.endswith(".dylib"):
                    index.setdefault(name, (Path(current) / name).resolve(strict=False))
    return index


def relocate(lib_dir: Path, roots) -> int:
    lib_dir.mkdir(parents=True, exist_ok=True)
    lib_dir = lib_dir.resolve()
    bundled = index_bundled_dylibs(roots, lib_dir)
    queue = [path.resolve() for path in iter_macho(roots)]
    seen = set()
    touched = 0

    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)

        changes = []
        for dependency in dependencies(current):
            if not is_external(dependency):
                continue
            name = os.path.basename(dependency)
            if name in bundled:
                # The same library already ships in the bundle (for example PostgreSQL's own
                # libpq, which its extensions reference by the absolute path of the build machine).
                target_dir = bundled[name].parent
            else:
                destination = lib_dir / name
                if not destination.exists():
                    source = Path(os.path.realpath(dependency))
                    if not source.exists():
                        raise SystemExit(f"{current}: dependency {dependency} does not exist")
                    shutil.copy2(source, destination)
                    make_writable(destination)
                    queue.append(destination)
                bundled[name] = destination
                target_dir = lib_dir
            relative = os.path.relpath(target_dir, current.parent)
            prefix = "@loader_path" if relative == "." else f"@loader_path/{relative}"
            changes.append((dependency, f"{prefix}/{name}"))

        in_lib_dir = current.parent == lib_dir
        if not changes and not in_lib_dir:
            continue

        make_writable(current)
        command = ["install_name_tool"]
        for old, new in changes:
            command += ["-change", old, new]
        if in_lib_dir:
            command += ["-id", f"@loader_path/{current.name}"]
        command.append(str(current))
        run(*command)
        sign(current)
        touched += 1
        for old, new in changes:
            print(f"  {current.name}: {old} -> {new}")

    print(f"relocated {touched} file(s) into {lib_dir}")
    return 0


def verify(roots) -> int:
    problems = []
    checked = 0
    for path in iter_macho(roots):
        checked += 1
        for dependency in dependencies(path):
            if is_external(dependency):
                problems.append(f"{path}: {dependency}")
    if problems:
        print("Non-relocatable library references found:", file=sys.stderr)
        for problem in problems:
            print("  " + problem, file=sys.stderr)
        return 1
    print(f"verified {checked} Mach-O file(s): no references outside the system libraries")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    rel = sub.add_parser("relocate")
    rel.add_argument("--lib-dir", required=True, type=Path)
    rel.add_argument("paths", nargs="+")
    ver = sub.add_parser("verify")
    ver.add_argument("paths", nargs="+")
    args = parser.parse_args()
    if args.command == "relocate":
        return relocate(args.lib_dir, args.paths)
    return verify(args.paths)


if __name__ == "__main__":
    sys.exit(main())
