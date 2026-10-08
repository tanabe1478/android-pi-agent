package io.github.tanabe1478.androidpi;

import android.content.Context;
import android.system.Os;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class RuntimePaths {
  private RuntimePaths() {}

  static File state(Context context) {
    return new File(context.getFilesDir(), "home/.android-pi");
  }

  static void initialize(Context context) throws Exception {
    for (String name : new String[] {"home", "work", "tmp", "log", "home/.android-pi"}) {
      File directory = new File(context.getFilesDir(), name);
      if (!directory.isDirectory() && !directory.mkdirs()) {
        throw new IOException("Cannot create private runtime directory.");
      }
      Os.chmod(directory.getAbsolutePath(), 0700);
    }

    File lock = new File(state(context), "runtime.lock");
    if (!lock.exists() && !lock.createNewFile()) {
      throw new IOException("Cannot create runtime lock.");
    }
    Os.chmod(lock.getAbsolutePath(), 0600);
  }

  static String readSmall(File file) throws IOException {
    try (FileInputStream input = new FileInputStream(file)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (bytes.size() + count > 8192) throw new IOException("Metadata is too large.");
        bytes.write(buffer, 0, count);
      }
      return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  static void writeSmall(File destination, String text) throws Exception {
    File temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      Os.chmod(temporary.getAbsolutePath(), 0600);
      output.write(text.getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
    }

    if (!temporary.renameTo(destination)) {
      throw new IOException("Cannot publish private runtime metadata.");
    }
  }

  static void status(Context context, String stage, String message) {
    try {
      JSONObject value = new JSONObject();
      value.put("stage", stage);
      value.put("message", message);
      writeSmall(new File(state(context), "status.json"), value.toString());
    } catch (Exception ignored) {
      // Failure to publish status is not a reason to expose raw process output to the UI.
    }
  }

  static boolean alive(int pid) {
    try {
      Os.kill(pid, 0);
      return true;
    } catch (Exception ignored) {
      return false;
    }
  }

  static Connection connection(Context context) {
    try {
      JSONObject value = new JSONObject(readSmall(new File(state(context), "bridge.json")));
      int port = value.getInt("port");
      int pid = value.getInt("pid");
      int parent = value.getInt("parentPid");
      String token = value.getString("token");

      if (value.getInt("version") != 1 || port < 1 || port > 65535 || pid < 1
          || parent != android.os.Process.myPid() || !token.matches("[A-Za-z0-9_-]{43}")
          || !alive(pid)) {
        return null;
      }
      return new Connection(port, pid, token);
    } catch (Exception ignored) {
      return null;
    }
  }

  static final class Connection {
    final int port;
    final int pid;
    final String token;

    Connection(int port, int pid, String token) {
      this.port = port;
      this.pid = pid;
      this.token = token;
    }
  }
}
