package io.github.tanabe1478.androidpi;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;

/** A distinct process and WebView data directory keep preview targets away from Pi/auth screens. */
public final class PreviewActivity extends Activity {
  private static boolean directoryConfigured;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private WebView webView;
  private int ownerPid;
  private int runtimePid;
  private boolean resumed;
  private TextView address;

  private final Runnable poll = new Runnable() {
    @Override
    public void run() {
      if (!resumed) return;
      RuntimePaths.Connection connection = RuntimePaths.connection(PreviewActivity.this, ownerPid);
      if (connection == null || connection.pid != runtimePid) {
        finish();
        return;
      }
      PreviewRequests.poll(PreviewActivity.this, webView, ownerPid);
      handler.postDelayed(this, 500);
    }
  };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    ownerPid = getIntent().getIntExtra("ownerPid", -1);
    runtimePid = getIntent().getIntExtra("runtimePid", -1);
    String url = getIntent().getStringExtra("url");
    if (!PreviewRequests.allowed(this, url, ownerPid, runtimePid)) {
      finish();
      return;
    }
    if (Build.VERSION.SDK_INT < 28) {
      Toast.makeText(this, "Preview requires Android 9 or later.", Toast.LENGTH_LONG).show();
      finish();
      return;
    }
    // This must precede every WebView initialization in the :preview process.
    if (!directoryConfigured) {
      WebView.setDataDirectorySuffix("preview");
      directoryConfigured = true;
    }
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setBackgroundColor(Color.rgb(16, 20, 25));
    LinearLayout toolbar = new LinearLayout(this);
    Button back = new Button(this);
    back.setText("Piへ戻る");
    back.setOnClickListener(view -> finish());
    address = new TextView(this);
    address.setTextColor(Color.WHITE);
    address.setText("Preview · local project");
    toolbar.addView(back);
    toolbar.addView(address, new LinearLayout.LayoutParams(0, -2, 1));
    layout.addView(toolbar);

    webView = new WebView(this);
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.getSettings().setSupportMultipleWindows(false);
    webView.setWebChromeClient(new WebChromeClient());
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !PreviewRequests.allowed(PreviewActivity.this, request.getUrl().toString(), ownerPid, runtimePid);
      }

      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (PreviewRequests.allowed(PreviewActivity.this, request.getUrl().toString(), ownerPid, runtimePid)) return null;
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
            java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
      }

      @Override
      public void onPageFinished(WebView view, String currentUrl) {
        if (PreviewRequests.allowed(PreviewActivity.this, currentUrl, ownerPid, runtimePid)) {
          address.setText("Preview · local:" + android.net.Uri.parse(currentUrl).getPort());
          writeState(true);
        } else writeState(false);
      }
    });
    layout.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(layout);
    webView.loadUrl(url);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    // A new runtime uses a new Activity; do not silently adopt another owner.
    if (intent.getIntExtra("ownerPid", -1) != ownerPid
        || intent.getIntExtra("runtimePid", -1) != runtimePid) {
      finish();
      return;
    }
    String url = intent.getStringExtra("url");
    if (webView != null && PreviewRequests.allowed(this, url, ownerPid, runtimePid)) webView.loadUrl(url);
  }

  private void writeState(boolean available) {
    try {
      JSONObject state = new JSONObject();
      state.put("version", 1);
      state.put("pid", Process.myPid());
      state.put("parentPid", ownerPid);
      state.put("runtimePid", runtimePid);
      state.put("available", available && resumed);
      state.put("debugging", BuildConfig.DEBUG);
      state.put("url", webView == null ? "" : webView.getUrl());
      RuntimePaths.writeSmall(new File(RuntimePaths.state(this), "preview-state.json"), state.toString());
    } catch (Exception ignored) {
      // Keep page contents, addresses and private metadata out of logs.
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    resumed = true;
    if (webView != null) {
      writeState(PreviewRequests.allowed(this, webView.getUrl(), ownerPid, runtimePid));
      handler.post(poll);
    }
  }

  @Override
  protected void onPause() {
    resumed = false;
    handler.removeCallbacks(poll);
    writeState(false);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    resumed = false;
    handler.removeCallbacks(poll);
    writeState(false);
    if (webView != null) webView.destroy();
    super.onDestroy();
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) webView.goBack();
    else super.onBackPressed();
  }
}
