#!/usr/bin/env python3
"""Package existing local dependencies/native assets. Never download or run npm scripts."""
import argparse
import gzip
import hashlib
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import stat
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "android/app/src/main/assets"
SOURCE_FILES = (
    "package.json",
    "package-lock.json",
    "ui/index.html",
    "ui/style.css",
    "ui/app.js",
    "ui/client.js",
    "ui/components.js",
    "ui/markdown.js",
    "ui/presentation.js",
    "ui/vendor/marked.js",
    "ui/vendor/marked.LICENSE",
    "ui/vendor/README.md",
    "shared/commands.js",
    "runtime/main.ts",
    "runtime/kernel.ts",
    "runtime/contracts.ts",
    "runtime/protocol.ts",
    "runtime/bridge.ts",
    "runtime/host-channel.ts",
    "runtime/credentials.ts",
    "runtime/auth.ts",
    "ui/auth.js",
)


def sha256(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compatible(values, target):
    if not values:
        return True
    positive = [value for value in values if not value.startswith("!")]
    return "!" + target not in values and (not positive or target in positive or "any" in positive)


def resolve_package(packages, issuer, name):
    for parent in (PurePosixPath(issuer), *PurePosixPath(issuer).parents):
        candidate = (parent / "node_modules" / name).as_posix()
        if candidate in packages:
            return candidate
    raise ValueError(f"Required dependency is missing from the lock: {name}")


def installed_directory(root, key, version):
    name = key.split("node_modules/")[-1]
    # A borrowed tree can hoist an identical locked package. Materialize it at the lock's path.
    for directory in (root / key, root / "node_modules" / name):
        manifest = directory / "package.json"
        if manifest.is_file():
            actual = json.loads(manifest.read_text())
            if actual.get("name") == name and actual.get("version") == version:
                return directory
    return None


def production_packages(root):
    lock = json.loads((root / "package-lock.json").read_text())
    packages = lock["packages"]
    selected = set()
    omitted = set()

    def visit(issuer, name, optional=False):
        key = resolve_package(packages, issuer, name)
        metadata = packages[key]
        supported = compatible(metadata.get("os"), "android") and compatible(
            metadata.get("cpu"), "arm64"
        )
        if not supported:
            if optional:
                return
            raise ValueError(f"Required dependency does not support Android ARM64: {key}")

        installed = installed_directory(root, key, metadata["version"])
        if installed is None:
            if optional:
                omitted.add(key)
                return
            raise ValueError(f"Missing local dependency or version does not match the lock: {key}")
        if "pi-coding-agent" in key:
            raise ValueError("A separate Pi CLI must not be included in the runtime bundle")
        if key in selected:
            return
        selected.add(key)

        optional_names = metadata.get("optionalDependencies", {})
        for dependency in metadata.get("dependencies", {}):
            visit(key, dependency, dependency in optional_names)
        for dependency in optional_names:
            visit(key, dependency, True)

    for dependency in packages[""].get("dependencies", {}):
        visit("", dependency)
    return sorted(selected), sorted(omitted)


def validate_rootfs(file):
    required = {"usr/bin/node", "usr/bin/bash", "usr/bin/flock", "usr/etc/tls/cert.pem"}
    seen = set()
    with tarfile.open(file, "r:gz") as archive:
        for item in archive:
            name = PurePosixPath(item.name)
            if any(part.startswith("._") for part in name.parts):
                continue  # macOS AppleDouble metadata is not part of the executable prefix.
            if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != "usr":
                raise ValueError("Unsafe native archive path")
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()):
                raise ValueError("Unsupported native archive entry")
            link = PurePosixPath(item.linkname)
            if item.islnk() and (link.is_absolute() or ".." in link.parts):
                raise ValueError("Unsafe native hard link")
            if item.issym():
                if PurePosixPath(item.linkname).is_absolute():
                    if not item.linkname.startswith("/system/"):
                        raise ValueError("Native archive contains an unrelocated absolute symlink")
                else:
                    target = posixpath.normpath((name.parent / item.linkname).as_posix())
                    if target != "usr" and not target.startswith("usr/"):
                        raise ValueError("Native symlink escapes the executable prefix")
            if item.name in required:
                if not item.isfile() or ("/bin/" in item.name and not item.mode & 0o111):
                    raise ValueError("Required native file is not executable/regular")
                seen.add(item.name)
    if seen != required:
        raise ValueError("Native archive is incomplete")


def repack_rootfs(source, destination):
    # Strip BSD/macOS archive extensions that Android toybox does not need.
    with tarfile.open(source, "r:gz") as original, destination.open("wb") as stream:
        with gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for item in original:
                    if any(part.startswith("._") for part in PurePosixPath(item.name).parts):
                        continue
                    item.uid = item.gid = 0
                    item.uname = item.gname = ""
                    item.mtime = 0
                    item.pax_headers = {}
                    archive.addfile(item, original.extractfile(item) if item.isfile() else None)


def host_binary(file):
    with file.open("rb") as stream:
        header = stream.read(20)
    if header[:4] in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"):
        return True
    if header[:4] == b"\x7fELF":
        return len(header) < 20 or int.from_bytes(header[18:20], "little") != 183
    return False


def add_file(archive, source, destination):
    if source.is_symlink():
        raise ValueError(f"Source file must not be a symlink: {destination}")
    if not source.is_file():
        raise ValueError(f"Source file is missing: {destination}")
    if host_binary(source):
        return False

    info = archive.gettarinfo(str(source), destination)
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    info.mode = 0o700 if source.stat().st_mode & stat.S_IXUSR else 0o600
    with source.open("rb") as stream:
        archive.addfile(info, stream)
    return True


def build(root, rootfs, output):
    validate_rootfs(rootfs)
    packages, omitted = production_packages(root)
    locked_metadata = json.loads((root / "package-lock.json").read_text())["packages"]

    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        staging = Path(temporary)
        runtime = staging / "runtime.bin"
        with runtime.open("wb") as stream, gzip.GzipFile(
            filename="", fileobj=stream, mode="wb", mtime=0
        ) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                # Android toybox --restrict treats the first archive entry as its allowed root.
                application = tarfile.TarInfo("app")
                application.type = tarfile.DIRTYPE
                application.mode = 0o700
                archive.addfile(application)

                for file in SOURCE_FILES:
                    add_file(archive, root / file, "app/" + file)
                for package in packages:
                    metadata = locked_metadata[package]
                    directory = installed_directory(root, package, metadata["version"])
                    for file in sorted(directory.rglob("*")):
                        relative = file.relative_to(directory)
                        excluded = {"node_modules", ".bin", ".git"}.intersection(relative.parts)
                        if excluded or file.name.startswith(".env"):
                            continue

                        # Do not follow external symlinks or copy host-specific executables.
                        if file.is_symlink():
                            raise ValueError(
                                f"Dependency symlink needs explicit handling: {package}/{relative}"
                            )
                        if file.is_file():
                            add_file(archive, file, "app/" + package + "/" + relative.as_posix())

        native = staging / "rootfs.bin"
        repack_rootfs(rootfs, native)
        files = {
            name: {"sha256": sha256(staging / name), "size": (staging / name).stat().st_size}
            for name in ("rootfs.bin", "runtime.bin")
        }
        bundle_id = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        manifest = {
            "version": 1,
            "bundleId": bundle_id,
            "files": files,
            "productionPackageCount": len(packages),
            "omittedOptionalPackages": omitted,
        }

        (staging / "bundle.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for name in ("rootfs.bin", "runtime.bin", "bundle.json"):
            os.replace(staging / name, output / name)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--rootfs", type=Path, required=True, help="Existing trusted ARM64 Termux rootfs.bin"
    )
    parser.add_argument("--output", type=Path, default=ASSETS)
    args = parser.parse_args()
    metadata = build(ROOT, args.rootfs.resolve(), args.output.resolve())
    count = metadata["productionPackageCount"]
    print(f"Bundled {count} production packages; no downloads or package scripts.")
    if metadata["omittedOptionalPackages"]:
        print("Unavailable optional Android packages: " + ", ".join(metadata["omittedOptionalPackages"]))
    print(f"Private build assets: {args.output}")


if __name__ == "__main__":
    main()
