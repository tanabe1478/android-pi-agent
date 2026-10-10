package io.github.tanabe1478.androidpi;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.UUID;

/** Foreground-only, owner-bound consumption. A runtime restart never replays an old request. */
final class PreviewRequests {
  private PreviewRequests() {}

  static boolean allowed(Context context, String value, int ownerPid, int runtimePid) {
    try {
      RuntimePaths.Connection connection = RuntimePaths.connection(context, ownerPid);
      Uri uri = Uri.parse(value);
      return connection != null && connection.pid == runtimePid
          && "http".equals(uri.getScheme()) && uri.getUserInfo() == null
          && ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()))
          && uri.getPort() > 0 && uri.getPort() <= 65535
          && uri.getPort() != 1455 && uri.getPort() != connection.port;
    } catch (Exception ignored) {
      return false;
    }
  }

  static void poll(Activity activity, WebView preview, int ownerPid) {
    File file = new File(RuntimePaths.state(activity), "preview-request.json");
    File claimed = new File(RuntimePaths.state(activity), ".preview-" + UUID.randomUUID() + ".json");
    try {
      BasicFileAttributes attributes = Files.readAttributes(file.toPath(),
          BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!attributes.isRegularFile() || attributes.size() > 8192) return;
      // Rename before reading; delete only our claimed request, not a later publication.
      if (!file.renameTo(claimed)) return;
      JSONObject request = new JSONObject(RuntimePaths.readSmall(claimed));
      String url = request.getString("url");
      int runtimePid = request.getInt("runtimePid");
      long age = System.currentTimeMillis() - request.getLong("createdAt");
      if (request.getInt("version") != 1 || request.getInt("parentPid") != ownerPid
          || !request.getString("id").matches("[a-f0-9-]{36}") || age < 0 || age > 60000
          || !allowed(activity, url, ownerPid, runtimePid)) return;
      if (preview != null) preview.loadUrl(url);
      else activity.startActivity(new Intent(activity, PreviewActivity.class)
          .putExtra("url", url).putExtra("ownerPid", ownerPid).putExtra("runtimePid", runtimePid));
    } catch (Exception ignored) {
      // Missing, malformed, stale or failed requests are never retried or logged with page data.
    } finally {
      claimed.delete();
    }
  }
}
