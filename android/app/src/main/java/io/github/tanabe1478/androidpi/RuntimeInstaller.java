package io.github.tanabe1478.androidpi;

import android.content.Context;
import android.system.Os;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.UUID;

final class RuntimeInstaller {
  private RuntimeInstaller() {}

  private static JSONObject manifest(Context context) throws Exception {
    try (InputStream input = context.getAssets().open("bundle.json")) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (bytes.size() + count > 8192) throw new IOException("Bundle manifest is too large.");
        bytes.write(buffer, 0, count);
      }
      JSONObject value = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      if (value.getInt("version") != 1 || !value.getString("bundleId").matches("[a-f0-9]{64}")) {
        throw new IOException("Unsupported runtime bundle.");
      }
      return value;
    }
  }

  private static boolean prefixPresent(File files) {
    return new File(files, "usr/bin/node").canExecute()
        && new File(files, "usr/bin/bash").canExecute()
        && new File(files, "usr/bin/flock").canExecute()
        && new File(files, "usr/etc/tls/cert.pem").isFile();
  }

  private static boolean appPresent(File files) {
    return new File(files, "app/runtime/main.ts").isFile()
        && new File(files, "app/ui/index.html").isFile()
        && new File(files, "app/node_modules/@earendil-works/pi-durable/package.json").isFile();
  }

  static boolean isInstalled(Context context) {
    try {
      return manifest(context).getString("bundleId").equals(
          RuntimePaths.readSmall(new File(context.getFilesDir(), ".bundle-id")).trim())
          && prefixPresent(context.getFilesDir()) && appPresent(context.getFilesDir());
    } catch (Exception ignored) {
      return false;
    }
  }

  static void install(Context context) throws Exception {
    JSONObject bundle = manifest(context);
    JSONObject files = bundle.getJSONObject("files");
    File destination = context.getFilesDir();
    File prefix = new File(destination, "usr");
    File prefixReceipt = new File(destination, ".rootfs-sha256");
    String prefixHash = files.getJSONObject("rootfs.bin").getString("sha256");

    // Never overwrite an existing prefix: manually installed CLIs live here too.
    boolean needsPrefix = !prefix.exists();
    if (!needsPrefix && (!prefixPresent(destination) || !prefixReceipt.isFile()
        || !prefixHash.equals(RuntimePaths.readSmall(prefixReceipt).trim()))) {
      throw new IOException("Existing native baseline requires explicit inspection or migration.");
    }

    File staging = new File(destination, ".bootstrap-" + UUID.randomUUID());
    if (!staging.mkdirs()) throw new IOException("Cannot stage runtime bundle.");
    Os.chmod(staging.getAbsolutePath(), 0700);
    boolean preserveRecovery = false;

    try {
      if (needsPrefix) extract(context, staging, "rootfs.bin", files.getJSONObject("rootfs.bin"));
      extract(context, staging, "runtime.bin", files.getJSONObject("runtime.bin"));

      if ((needsPrefix && !prefixPresent(staging)) || !appPresent(staging)) {
        throw new IOException("Runtime bundle is incomplete.");
      }
      if (needsPrefix) {
        if (!new File(staging, "usr").renameTo(prefix)) {
          throw new IOException("Cannot publish native baseline.");
        }
        RuntimePaths.writeSmall(prefixReceipt, prefixHash);
      }

      File application = new File(destination, "app");
      File backup = new File(staging, "previous-app");
      boolean hadApplication = application.exists();
      if (hadApplication && !application.renameTo(backup)) {
        throw new IOException("Cannot retain previous application runtime.");
      }

      try {
        if (!new File(staging, "app").renameTo(application)) {
          throw new IOException("Cannot publish application runtime.");
        }
        RuntimePaths.writeSmall(new File(destination, ".bundle-id"), bundle.getString("bundleId"));
      } catch (Exception failure) {
        deleteTree(application);
        if (hadApplication && !backup.renameTo(application)) {
          preserveRecovery = true;
          throw new IOException("Application rollback needs manual recovery.");
        }
        throw failure;
      }
    } finally {
      if (!preserveRecovery) deleteTree(staging);
    }
  }

  private static void extract(Context context, File staging, String name, JSONObject metadata)
      throws Exception {
    String expectedHash = metadata.getString("sha256");
    long expectedSize = metadata.getLong("size");
    if (!expectedHash.matches("[a-f0-9]{64}") || expectedSize < 1) {
      throw new IOException("Invalid runtime asset metadata.");
    }

    File archive = new File(staging, name);
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    long size = 0;
    try (InputStream input = context.getAssets().open(name);
         FileOutputStream output = new FileOutputStream(archive)) {
      Os.chmod(archive.getAbsolutePath(), 0600);
      byte[] buffer = new byte[256 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        size += count;
        if (size > expectedSize) throw new IOException("Runtime asset size mismatch.");
        digest.update(buffer, 0, count);
        output.write(buffer, 0, count);
      }
    }
    StringBuilder hash = new StringBuilder();
    for (byte value : digest.digest()) hash.append(String.format("%02x", value & 0xff));
    if (size != expectedSize || !expectedHash.equals(hash.toString())) {
      throw new IOException("Runtime asset checksum mismatch.");
    }

    File output = new File(context.getFilesDir(), "log/extract.log");
    if (!output.exists()) output.createNewFile();
    Os.chmod(output.getAbsolutePath(), 0600);
    Process process = new ProcessBuilder("/system/bin/tar", "--restrict", "-o", "-xzf", archive.getAbsolutePath(),
        "-C", staging.getAbsolutePath()).redirectErrorStream(true).redirectOutput(output).start();
    int code;
    try {
      code = process.waitFor();
    } finally {
      if (process.isAlive()) process.destroyForcibly();
    }
    if (code != 0) throw new IOException("Runtime extraction failed; inspect private extract log.");
    if (!archive.delete()) throw new IOException("Cannot remove temporary runtime archive.");
  }

  private static void deleteTree(File file) {
    if (!Files.isSymbolicLink(file.toPath())) {
      File[] children = file.listFiles();
      if (children != null) {
        for (File child : children) deleteTree(child);
      }
    }
    file.delete();
  }
}
