import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("packager", Path(__file__).with_name("package-android.py"))
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lock = {"packages": {
            "": {"dependencies": {"fixture": "1.0.0"}, "devDependencies": {"dev-only": "1.0.0"}},
            "node_modules/fixture": {"version": "1.0.0", "dependencies": {"child": "2.0.0"},
                                     "optionalDependencies": {"android-optional": "1.0.0"}},
            "node_modules/fixture/node_modules/child": {"version": "2.0.0"},
            "node_modules/child": {"version": "1.0.0"},
            "node_modules/dev-only": {"version": "1.0.0"},
            "node_modules/android-optional": {"version": "1.0.0", "os": ["android"], "cpu": ["arm64"]},
        }}
        for name in packager.SOURCE_FILES:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture source\n")
        for key, metadata in self.lock["packages"].items():
            if not key or key == "node_modules/android-optional":
                continue
            directory = self.root / key
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "package.json").write_text(json.dumps({
                "name": key.split("node_modules/")[-1], "version": metadata["version"],
            }))
            (directory / "index.js").write_text("export const fixture = true;\n")
        (self.root / "package-lock.json").write_text(json.dumps(self.lock))
        self.native = self.root / "native.bin"
        self.native_archive(self.native)

    def native_archive(self, file, extra=None):
        with tarfile.open(file, "w:gz") as archive:
            for name in ["usr/bin/node", "usr/bin/bash", "usr/bin/flock", "usr/etc/tls/cert.pem", "._usr"]:
                item = tarfile.TarInfo(name)
                item.mode = 0o700 if "/bin/" in name else 0o600
                item.size = len(b"native fixture")
                archive.addfile(item, io.BytesIO(b"native fixture"))
            if extra:
                archive.addfile(extra)

    def test_only_locked_production_closure_is_selected(self):
        selected, omitted = packager.production_packages(self.root)
        self.assertEqual(selected, ["node_modules/fixture", "node_modules/fixture/node_modules/child"])
        self.assertEqual(omitted, ["node_modules/android-optional"])

        manifest = self.root / "node_modules/fixture/package.json"
        manifest.write_text(json.dumps({"name": "fixture", "version": "0.0.0"}))
        with self.assertRaisesRegex(ValueError, "does not match"):
            packager.production_packages(self.root)

    def test_identical_hoisted_version_is_materialized_at_locked_path(self):
        nested = self.root / "node_modules/fixture/node_modules/child"
        for file in nested.iterdir():
            file.unlink()
        nested.rmdir()
        hoisted = self.root / "node_modules/child/package.json"
        hoisted.write_text(json.dumps({"name": "child", "version": "2.0.0"}))

        packager.build(self.root, self.native, self.root / "out")
        with tarfile.open(self.root / "out/runtime.bin") as archive:
            name = "app/node_modules/fixture/node_modules/child/package.json"
            metadata = json.load(archive.extractfile(name))
            self.assertEqual(metadata["version"], "2.0.0")

    def test_bundle_is_reproducible_and_excludes_private_dev_and_host_files(self):
        private = self.root / ".demo/auth.json"
        private.parent.mkdir()
        private.write_text("private fixture must not enter archive")
        host = self.root / "node_modules/fixture/bin/host-tool"
        host.parent.mkdir()
        host.write_bytes(b"\xcf\xfa\xed\xfe" + b"host executable")
        first = packager.build(self.root, self.native, self.root / "first")
        second = packager.build(self.root, self.native, self.root / "second")
        self.assertEqual(first, second)

        with tarfile.open(self.root / "first/runtime.bin") as archive:
            members = archive.getmembers()
            self.assertEqual(members[0].name, "app")
            self.assertTrue(members[0].isdir())
            self.assertEqual(members[0].mode, 0o700)
            names = [member.name for member in members[1:]]
            self.assertTrue(all(name.startswith("app/") for name in names))
            self.assertFalse(any("dev-only" in name or "auth.json" in name or "host-tool" in name for name in names))
            self.assertIn("app/node_modules/fixture/node_modules/child/index.js", names)
        with tarfile.open(self.root / "first/rootfs.bin") as archive:
            self.assertNotIn("._usr", archive.getnames())
        packager.validate_rootfs(self.root / "first/rootfs.bin")

    def test_archive_traversal_and_escaping_symlinks_are_rejected(self):
        for name, target in [("../escape", None), ("usr/bin/link", "../../../outside")]:
            item = tarfile.TarInfo(name)
            if target:
                item.type = tarfile.SYMTYPE
                item.linkname = target
            self.native_archive(self.native, item)
            with self.assertRaises(ValueError):
                packager.validate_rootfs(self.native)

    def test_dependency_symlinks_are_not_followed(self):
        link = self.root / "node_modules/fixture/secret-link"
        link.symlink_to(self.root / "package-lock.json")
        with self.assertRaisesRegex(ValueError, "symlink"):
            packager.build(self.root, self.native, self.root / "out")


if __name__ == "__main__":
    unittest.main()
