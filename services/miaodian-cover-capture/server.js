const express = require("express");
const { chromium } = require("playwright");

const DEFAULT_ALLOWED_HOSTS = [
  "cloud1-d7guxi87wac162e06-1377286614.ap-shanghai.app.tcloudbase.com",
];
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const CAPTURE_SECRET = process.env.COVER_CAPTURE_SECRET || "";
const CAPTURE_DEVICE_SCALE_FACTOR = clampNumber(process.env.CAPTURE_DEVICE_SCALE_FACTOR, 1, 1, 2);
const ALLOWED_HOSTS = Array.from(new Set(
  String(process.env.ALLOWED_PREVIEW_HOSTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .concat(DEFAULT_ALLOWED_HOSTS)
));

let browserPromise = null;
let queue = Promise.resolve();

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? number : fallback;

  return Math.min(max, Math.max(min, normalized));
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }

  return browserPromise;
}

function validatePreviewUrl(value) {
  const url = new URL(String(value || ""));

  if (url.protocol !== "https:") {
    throw new Error("previewUrl must use https");
  }

  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new Error("previewUrl host is not allowed");
  }

  if (url.pathname !== "/preview") {
    throw new Error("previewUrl path is not allowed");
  }

  if (!url.searchParams.get("token")) {
    throw new Error("previewUrl token is required");
  }

  return url.toString();
}

function requireAuth(req) {
  if (!CAPTURE_SECRET) {
    return;
  }

  const authorization = String(req.headers.authorization || "");

  if (authorization !== `Bearer ${CAPTURE_SECRET}`) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function enqueue(task) {
  const run = queue.then(task, task);

  queue = run.catch(() => {});
  return run;
}

async function dismissCloudBaseNotice(page) {
  await page.waitForTimeout(1300);

  const confirmTextPattern = new RegExp("\\u786e\\u5b9a\\u8bbf\\u95ee");

  const clickedByLocator = await page
    .getByRole("button", { name: confirmTextPattern })
    .click({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  const clicked = clickedByLocator || await page.evaluate(() => {
    const keyword = "\u786e\u5b9a\u8bbf\u95ee";
    const nodes = Array.from(document.querySelectorAll("button,a,[role='button'],[onclick]"));
    const target = nodes.find((node) => {
      const text = String(node.textContent || "").replace(/\s+/g, "");

      if (!text.includes(keyword)) {
        return false;
      }

      const style = window.getComputedStyle(node);
      const disabled =
        node.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        /\bdisabled\b/i.test(String(node.className || ""));

      return style.display !== "none" && style.visibility !== "hidden" && !disabled;
    });

    if (!target) {
      return false;
    }

    target.click();
    return true;
  }).catch(() => false);

  if (!clicked) {
    return;
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
}

async function capturePreview(options) {
  const browser = await getBrowser();
  const width = clampNumber(options.width, 900, 320, 1400);
  const height = clampNumber(options.height, 576, 240, 1000);
  const waitMs = clampNumber(options.waitMs, 2000, 300, 6000);
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
  });

  try {
    await page.goto(options.previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await dismissCloudBaseNotice(page);
    await Promise.race([
      page.waitForFunction(
        () => window.__MIAODIAN_COVER_READY__ === true,
        null,
        { timeout: waitMs }
      ),
      page.waitForTimeout(waitMs),
    ]).catch(() => {});

    return await page.screenshot({
      type: "png",
      fullPage: false,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

process.on("SIGTERM", async () => {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await (browser && browser.close().catch(() => {}));
  }

  process.exit(0);
});

const app = express();

app.use(express.json({ limit: "24kb" }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "miaodian-cover-capture",
    authEnabled: !!CAPTURE_SECRET,
    deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
    allowedHosts: ALLOWED_HOSTS,
  });
});

app.post("/capture", async (req, res) => {
  const startedAt = Date.now();

  try {
    requireAuth(req);

    const previewUrl = validatePreviewUrl(req.body && req.body.previewUrl);
    const png = await enqueue(() =>
      capturePreview({
        previewUrl,
        width: req.body && req.body.width,
        height: req.body && req.body.height,
        waitMs: req.body && req.body.waitMs,
      })
    );

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Capture-Duration-Ms", String(Date.now() - startedAt));
    res.setHeader("X-Capture-Dpr", String(CAPTURE_DEVICE_SCALE_FACTOR));
    res.send(png);
  } catch (error) {
    const statusCode = error.statusCode || 400;

    res.status(statusCode).json({
      ok: false,
      error: error.message || "capture failed",
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`miaodian-cover-capture listening on ${HOST}:${PORT}`);
});
