package io.github.tanabe1478.androidpi;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.system.Os;
import android.view.Surface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.UUID;
import java.util.function.BooleanSupplier;

/** Draw only the foreground Preview WebView into an owned offscreen surface, never a window. */
final class PreviewCapture {
  private final Activity activity;
  private final WebView view;
  private final int ownerPid;
  private final int runtimePid;
  private final BooleanSupplier foreground;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private Capture pending;

  PreviewCapture(Activity activity, WebView view, int ownerPid, int runtimePid,
      BooleanSupplier foreground) {
    this.activity = activity;
    this.view = view;
    this.ownerPid = ownerPid;
    this.runtimePid = runtimePid;
    this.foreground = foreground;
  }

  void poll() {
    if (pending != null || !foreground.getAsBoolean()) return;
    File directory = RuntimePaths.state(activity);
    File request = new File(directory, "preview-capture.json");
    File claimed = new File(directory, ".capture-" + UUID.randomUUID() + ".json");
    boolean started = false;
    try {
      BasicFileAttributes info = Files.readAttributes(request.toPath(),
          BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!info.isRegularFile() || info.size() > 8192 || !request.renameTo(claimed)) return;
      JSONObject value = new JSONObject(RuntimePaths.readSmall(claimed));
      String id = value.getString("id");
      long age = System.currentTimeMillis() - value.getLong("createdAt");
      if (value.getInt("version") != 1 || !id.matches("[a-f0-9-]{36}")
          || value.getInt("parentPid") != ownerPid || value.getInt("runtimePid") != runtimePid
          || value.getInt("previewPid") != Process.myPid() || age < 0 || age > 10000) return;
      pending = new Capture(directory, claimed, value);
      started = true;
      pending.start();
    } catch (Exception | OutOfMemoryError ignored) {
      if (pending != null) pending.finish(false);
    } finally {
      if (!started) claimed.delete();
    }
  }

  void cancel() {
    if (pending != null) pending.finish(false);
  }

  private final class Capture {
    final File claimed;
    final File marker;
    final File temporary;
    final File image;
    final File resultFile;
    final String url;
    final long deadline;
    final JSONObject result = new JSONObject();
    final Runnable timeout = () -> finish(false);
    ImageReader reader;
    boolean finished;
    boolean published;
    int width;
    int height;

    Capture(File directory, File claimed, JSONObject value) throws Exception {
      this.claimed = claimed;
      String id = value.getString("id");
      marker = new File(directory, ".preview-image-" + id + ".pending");
      temporary = new File(directory, ".preview-image-" + id + ".png.tmp");
      image = new File(directory, ".preview-image-" + id + ".png");
      resultFile = new File(directory, ".preview-image-" + id + ".json");
      url = value.getString("url");
      deadline = value.getLong("createdAt") + 10000;
      result.put("version", 1);
      result.put("id", id);
      result.put("parentPid", ownerPid);
      result.put("runtimePid", runtimePid);
      result.put("pid", Process.myPid());
      result.put("ok", false);
      result.put("renderer", "webview-hardware");
    }

    boolean active() {
      return !finished && leaseActive();
    }

    boolean leaseActive() {
      try {
        BasicFileAttributes info = Files.readAttributes(marker.toPath(),
            BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        return foreground.getAsBoolean() && view.isShown()
            && url.equals(view.getUrl()) && info.isRegularFile() && info.size() == 0
            && System.currentTimeMillis() <= deadline
            && PreviewRequests.allowed(activity, url, ownerPid, runtimePid);
      } catch (Exception ignored) {
        return false;
      }
    }

    void start() {
      if (!active()) {
        finish(false);
        return;
      }
      handler.postDelayed(timeout, Math.max(0, deadline - System.currentTimeMillis()));
      view.postVisualStateCallback(System.nanoTime(), new WebView.VisualStateCallback() {
        @Override
        public void onComplete(long requestId) {
          if (finished) return;
          if (!active()) {
            finish(false);
            return;
          }
          draw();
        }
      });
    }

    void draw() {
      try {
        width = view.getWidth();
        height = view.getHeight();
        if (width < 1 || height < 1 || (long) width * height > 4000000) {
          finish(false);
          return;
        }
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::imageAvailable, handler);
        Surface surface = reader.getSurface();
        Canvas canvas = surface.lockHardwareCanvas();
        try {
          if (!canvas.isHardwareAccelerated()) throw new IOException("Hardware draw unavailable.");
          canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
          canvas.clipRect(0, 0, width, height);
          view.draw(canvas);
        } finally {
          surface.unlockCanvasAndPost(canvas);
        }
      } catch (Exception | OutOfMemoryError ignored) {
        finish(false);
      }
    }

    void imageAvailable(ImageReader source) {
      if (finished) return;
      Bitmap bitmap = null;
      try (Image frame = source.acquireLatestImage()) {
        if (frame == null) return;
        if (!active() || frame.getWidth() != width || frame.getHeight() != height) {
          finish(false);
          return;
        }
        Image.Plane[] planes = frame.getPlanes();
        if (planes.length != 1 || planes[0].getPixelStride() != 4) {
          finish(false);
          return;
        }
        int rowStride = planes[0].getRowStride();
        ByteBuffer pixels = planes[0].getBuffer();
        long required = (long) (height - 1) * rowStride + (long) width * 4;
        if (rowStride < width * 4 || required > pixels.remaining()) {
          finish(false);
          return;
        }
        int offset = pixels.position();
        ByteBuffer packed = ByteBuffer.allocateDirect(width * height * 4);
        for (int row = 0; row < height; row++) {
          ByteBuffer slice = pixels.duplicate();
          slice.position(offset + row * rowStride);
          slice.limit(offset + row * rowStride + width * 4);
          packed.put(slice);
        }
        packed.flip();
        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(packed);
        if (!temporary.createNewFile()) throw new IOException("Capture collision.");
        Os.chmod(temporary.getAbsolutePath(), 0600);
        try (FileOutputStream output = new FileOutputStream(temporary)) {
          if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, new LimitedOutput(output))) {
            throw new IOException("Capture failed.");
          }
          output.getFD().sync();
        }
        if (!active() || image.exists() || !temporary.renameTo(image)) {
          finish(false);
          return;
        }
        published = true;
        finish(true);
      } catch (Exception | OutOfMemoryError ignored) {
        // No bitmap, URL, token, private path or raw rendering exception in logs.
        finish(false);
      } finally {
        if (bitmap != null) bitmap.recycle();
      }
    }

    void finish(boolean success) {
      if (finished) return;
      boolean mayPublish = active();
      finished = true;
      handler.removeCallbacks(timeout);
      try {
        if (mayPublish) {
          result.put("ok", success);
          RuntimePaths.writeSmall(resultFile, result.toString());
          // Recheck after publication: a timeout may have revoked the lease on another process.
          if (!leaseActive()) {
            resultFile.delete();
            if (published) image.delete();
          }
        } else if (published) image.delete();
      } catch (Exception ignored) {
        if (published) image.delete();
      } finally {
        if (reader != null) {
          reader.setOnImageAvailableListener(null, null);
          reader.close();
        }
        temporary.delete();
        claimed.delete();
        if (pending == this) pending = null;
      }
    }
  }

  private static final class LimitedOutput extends FilterOutputStream {
    private int size;

    LimitedOutput(OutputStream output) {
      super(output);
    }

    private void count(int bytes) throws IOException {
      if (size + bytes > 8 * 1024 * 1024) throw new IOException("Capture is too large.");
      size += bytes;
    }

    @Override
    public void write(int value) throws IOException {
      count(1);
      out.write(value);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      count(length);
      out.write(bytes, offset, length);
    }
  }
}
