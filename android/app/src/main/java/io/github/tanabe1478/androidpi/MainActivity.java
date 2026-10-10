package io.github.tanabe1478.androidpi;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;

public final class MainActivity extends Activity {
  private final Handler handler = new Handler(Looper.getMainLooper());
  private WebView webView;
  private LinearLayout startup;
  private TextView status;
  private Button retry;
  private RuntimePaths.Connection loaded;
  private long lastLoad;
  private boolean resumed;

  private final Runnable poll = new Runnable() {
    @Override
    public void run() {
      if (!resumed) return;
      connectOrStatus();
      if (loaded != null) PreviewRequests.poll(MainActivity.this, null, android.os.Process.myPid());
      handler.postDelayed(this, 500);
    }
  };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    FrameLayout frame = new FrameLayout(this);
    frame.setBackgroundColor(Color.rgb(16, 20, 25));

    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(16, 20, 25));
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.getSettings().setSupportMultipleWindows(false);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    webView.setVisibility(View.GONE);
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (request.isForMainFrame() && request.hasGesture() && isChatGPTAuthorization(uri)) {
          Intent browser = new Intent(Intent.ACTION_VIEW, uri);
          browser.addCategory(Intent.CATEGORY_BROWSABLE);
          try {
            startActivity(browser);
          } catch (android.content.ActivityNotFoundException | SecurityException ignored) {
            Toast.makeText(MainActivity.this,
                "外部ブラウザを開けません。ブラウザアプリを確認してください。",
                Toast.LENGTH_LONG).show();
          }
          return true;
        }
        // Arbitrary remote, intent:, file: and OAuth callback navigations remain blocked.
        return loaded == null || !"http".equals(uri.getScheme())
            || !"127.0.0.1".equals(uri.getHost()) || uri.getPort() != loaded.port
            || uri.getUserInfo() != null;
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) loaded = null;
      }
    });
    frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));

    startup = new LinearLayout(this);
    startup.setOrientation(LinearLayout.VERTICAL);
    startup.setGravity(Gravity.CENTER);
    startup.setPadding(24, 24, 24, 24);
    TextView title = new TextView(this);
    title.setText("Android Pi");
    title.setTextSize(24);
    title.setTextColor(Color.WHITE);
    startup.addView(title);
    status = new TextView(this);
    status.setText("ローカルランタイムを準備しています…\n実モデルの利用にはChatGPT認証が必要です。");
    status.setTextColor(Color.LTGRAY);
    status.setPadding(0, 24, 0, 24);
    startup.addView(status);
    retry = new Button(this);
    retry.setText("起動を再試行");
    retry.setEnabled(false);
    retry.setOnClickListener(view -> {
      retry.setEnabled(false);
      startForegroundService(new Intent(this, RuntimeService.class));
    });
    startup.addView(retry);
    frame.addView(startup, new FrameLayout.LayoutParams(-1, -1));
    setContentView(frame);

    startForegroundService(new Intent(this, RuntimeService.class));
  }

  private static boolean isChatGPTAuthorization(Uri uri) {
    return "https".equals(uri.getScheme())
        && "auth.openai.com".equals(uri.getHost())
        && (uri.getPort() == -1 || uri.getPort() == 443)
        && "/api/accounts/authorize".equals(uri.getEncodedPath())
        && uri.getUserInfo() == null
        && uri.getFragment() == null;
  }

  private void connectOrStatus() {
    RuntimePaths.Connection connection = RuntimePaths.connection(this);
    if (connection != null) {
      if (loaded == null || loaded.pid != connection.pid || loaded.port != connection.port
          || !loaded.token.equals(connection.token)) {
        if (SystemClock.uptimeMillis() - lastLoad < 2000) return;
        loaded = connection;
        lastLoad = SystemClock.uptimeMillis();
        // Bootstrap through a fragment; app.js removes it and authenticates fetches with a header.
        webView.loadUrl("http://127.0.0.1:" + connection.port + "/#token=" + connection.token);
      }
      startup.setVisibility(View.GONE);
      webView.setVisibility(View.VISIBLE);
      return;
    }

    try {
      JSONObject value = new JSONObject(RuntimePaths.readSmall(
          new File(RuntimePaths.state(this), "status.json")));
      status.setText(value.getString("message"));
      boolean failed = "failed".equals(value.getString("stage"))
          || "stopped".equals(value.getString("stage"));
      retry.setEnabled(failed);
      if (failed) startup.setVisibility(View.VISIBLE);
    } catch (Exception ignored) {
      // Assets may still be staging; keep the native loading screen without leaking metadata.
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    resumed = true;
    handler.post(poll);
  }

  @Override
  protected void onPause() {
    resumed = false;
    handler.removeCallbacks(poll);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    resumed = false;
    handler.removeCallbacks(poll);
    webView.destroy();
    super.onDestroy();
  }

  @Override
  public void onBackPressed() {
    webView.evaluateJavascript("(() => {"
        + "const dialog = document.getElementById('dialog');"
        + "if (dialog?.open) { dialog.close(); return true; }"
        + "const settings = document.getElementById('settings-page');"
        + "if (settings && !settings.hidden) {"
        + "document.getElementById('settings-back')?.click(); return true; }"
        + "const suggestions = document.getElementById('suggestions');"
        + "if (suggestions && !suggestions.hidden) { suggestions.hidden = true; return true; }"
        + "return false; })()", value -> {
          if (!"true".equals(value)) super.onBackPressed();
        });
  }
}
