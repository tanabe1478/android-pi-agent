package io.github.tanabe1478.androidpi;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.system.Os;
import android.system.OsConstants;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public final class RuntimeService extends Service {
  private static final String CHANNEL = "android-pi-runtime";
  private static final String STOP = "io.github.tanabe1478.androidpi.STOP";

  private final Handler handler = new Handler(Looper.getMainLooper());
  private volatile boolean destroyed;
  private boolean runtimeActive;
  private Process process;
  private Thread worker;
  private PowerManager.WakeLock wakeLock;

  private final Runnable renewWakeLock = new Runnable() {
    @Override
    public void run() {
      synchronized (RuntimeService.this) {
        if (destroyed || !runtimeActive || wakeLock == null) return;
        wakeLock.acquire(180_000);
        handler.postDelayed(this, 60_000);
      }
    }
  };

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && STOP.equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }

    foreground(true);
    synchronized (this) {
      if (destroyed || (worker != null && worker.isAlive())) return START_STICKY;
      if (wakeLock == null) {
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "androidpi:runtime");
        wakeLock.setReferenceCounted(false);
      }
      runtimeActive = true;
      handler.removeCallbacks(renewWakeLock);
      renewWakeLock.run();
      worker = new Thread(this::runRuntime, "android-pi-runtime");
      worker.start();
    }
    return START_STICKY;
  }

  private synchronized void status(String stage, String message) {
    if (!destroyed) RuntimePaths.status(this, stage, message);
  }

  private void runRuntime() {
    try {
      RuntimePaths.initialize(this);
      if (!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a")) {
        status("failed", "このデモAPKはARM64端末専用です。");
        return;
      }
      status("starting", "ローカルランタイムを準備しています…");
      if (!RuntimeInstaller.isInstalled(this)) {
        status("extracting", "初回のファイル展開中です。しばらくお待ちください…");
        RuntimeInstaller.install(this);
      }
      if (destroyed) return;

      new File(RuntimePaths.state(this), "bridge.json").delete();
      for (int attempt = 0; attempt < 12 && !destroyed; attempt++) {
        Process child = spawn();
        synchronized (this) {
          if (destroyed) {
            child.destroy();
            return;
          }
          process = child;
        }

        // flock's explicit conflict code allows a departing orphan to release the profile.
        if (child.waitFor(500, TimeUnit.MILLISECONDS) && child.exitValue() == 73) {
          Thread.sleep(500);
          continue;
        }
        status("running", "ローカルデモを起動しています…");
        child.waitFor();
        if (!destroyed) {
          status("failed", "ランタイムが終了しました。再試行してください。");
        }
        return;
      }
      if (!destroyed) {
        status("failed", "別のランタイムが保存領域を使用中です。後で再試行してください。");
      }
    } catch (Exception failure) {
      if (!destroyed) {
        status("failed", "ランタイムを起動できません。アプリ内ログの確認が必要です。");
        android.util.Log.e("AndroidPi", "Runtime start failed: " + failure.getClass().getSimpleName());
      }
    } finally {
      synchronized (this) {
        runtimeActive = false;
        handler.removeCallbacks(renewWakeLock);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
      }
      handler.post(() -> {
        synchronized (RuntimeService.this) {
          if (!destroyed && !runtimeActive) foreground(false);
        }
      });
    }
  }

  private Process spawn() throws Exception {
    File files = getFilesDir();
    File prefix = new File(files, "usr");
    File home = new File(files, "home");
    File state = RuntimePaths.state(this);
    String node = new File(prefix, "bin/node").getAbsolutePath();
    String shell = new File(prefix, "bin/bash").getAbsolutePath();

    List<String> command = new ArrayList<>();
    command.add(new File(prefix, "bin/flock").getAbsolutePath());
    command.add("-E");
    command.add("73");
    command.add("-n");
    command.add("-F");
    command.add(new File(state, "runtime.lock").getAbsolutePath());
    command.add(node);
    command.add(new File(files, "app/runtime/main.ts").getAbsolutePath());
    command.add("--demo");
    command.add("--bridge-file");
    command.add("--state");
    command.add(state.getAbsolutePath());
    command.add("--workspace");
    command.add(new File(files, "work").getAbsolutePath());
    command.add("--shell");
    command.add(shell);
    command.add("--parent-pid");
    command.add(Integer.toString(android.os.Process.myPid()));

    ProcessBuilder builder = new ProcessBuilder(command);
    Map<String, String> environment = builder.environment();
    environment.put("HOME", home.getAbsolutePath());
    environment.put("PREFIX", prefix.getAbsolutePath());
    environment.put("TMPDIR", new File(files, "tmp").getAbsolutePath());
    environment.put("PATH", prefix.getAbsolutePath() + "/bin:/system/bin:/system/xbin");
    environment.put("LD_LIBRARY_PATH", new File(prefix, "lib").getAbsolutePath());
    environment.put("SHELL", shell);
    environment.put("TERM", "dumb");
    environment.put("LANG", "C.UTF-8");
    environment.put("OPENSSL_CONF", new File(prefix, "etc/tls/openssl.cnf").getAbsolutePath());
    environment.put("SSL_CERT_FILE", new File(prefix, "etc/tls/cert.pem").getAbsolutePath());
    builder.directory(new File(files, "work"));

    File log = new File(files, "log/node.log");
    if (!log.exists()) log.createNewFile();
    Os.chmod(log.getAbsolutePath(), 0600);
    builder.redirectErrorStream(true);
    builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
    return builder.start();
  }

  private void foreground(boolean running) {
    NotificationManager notifications = getSystemService(NotificationManager.class);
    notifications.createNotificationChannel(new NotificationChannel(
        CHANNEL, "Android Pi runtime", NotificationManager.IMPORTANCE_LOW));

    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
        PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop = PendingIntent.getService(this, 1,
        new Intent(this, RuntimeService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
    Notification notification = new Notification.Builder(this, CHANNEL)
        .setContentTitle("Android Pi Demo")
        .setContentText(running ? "ローカルのdurableランタイムを実行中（模擬モデル）"
            : "ランタイムは停止しています（模擬モデル）")
        .setSmallIcon(android.R.drawable.ic_media_play)
        .setContentIntent(open)
        .setOngoing(true)
        .addAction(new Notification.Action.Builder(null, "終了", stop).build())
        .build();
    startForeground(1, notification);
  }

  @Override
  public void onDestroy() {
    destroyed = true;
    handler.removeCallbacks(renewWakeLock);
    Process child;
    synchronized (this) {
      runtimeActive = false;
      child = process;
      if (worker != null) worker.interrupt();
      if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    if (child != null) {
      RuntimePaths.Connection connection = RuntimePaths.connection(this);
      if (child.isAlive() && connection != null) {
        try {
          // Android Process.destroy() can kill immediately; send SIGTERM explicitly to our ready child.
          Os.kill(connection.pid, OsConstants.SIGTERM);
        } catch (Exception ignored) {
          child.destroy();
        }
      } else {
        child.destroy();
      }
      new Thread(() -> {
        try {
          if (!child.waitFor(5, TimeUnit.SECONDS)) child.destroyForcibly();
        } catch (InterruptedException ignored) {
          Thread.currentThread().interrupt();
        }
      }, "android-pi-shutdown").start();
    }
    RuntimePaths.status(this, "stopped", "ランタイムは停止しています。");
    super.onDestroy();
  }
}
