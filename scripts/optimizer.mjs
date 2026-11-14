import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";

const INPUT_DIR = path.resolve(process.env.INPUT_DIR || "input");
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "optimizer-output");
const APP_URL = process.env.APP_URL || "http://127.0.0.1:4000";
const TIMEOUT = 20 * 60 * 1000;

const PACK_OPTIONS = {
  fileName: "texture",
  textureFormat: "png",
  removeFileExtension: true,
  prependFolderName: true,
  scale: 1,
  fitToSize: false,
  filter: "none",
  exporter: "Sparrow",
  width: 8192,
  height: 8192,
  fixedSize: false,
  powerOfTwo: false,
  spritePadding: 3,
  borderPadding: 1,
  allowRotation: true,
  allowTrim: true,
  trimMode: "trim",
  alphaThreshold: 0,
  detectIdentical: true,
  sortExportedRows: true,
  statsSI: 1024,
  packer: "OptimalPacker",
  packerMethod: "Automatic",
  tightPack: false,
  optimizePNG: true,
  characterFile: "none",
  base64Export: false
};

function ignoredPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.split("/").some(part =>
    part === ".gitkeep" ||
    part === ".DS_Store" ||
    part === "Thumbs.db" ||
    part === "desktop.ini" ||
    part === "__MACOSX" ||
    part.startsWith(".")
  );
}

async function addInputFiles(zip, directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (ignoredPath(relativePath)) continue;

    if (entry.isDirectory()) {
      count += await addInputFiles(zip, fullPath, relativePath);
    } else if (entry.isFile()) {
      zip.file(relativePath.replaceAll("\\", "/"), await fs.readFile(fullPath));
      count++;
    }
  }

  return count;
}

async function createInputZip() {
  let stat;
  try {
    stat = await fs.stat(INPUT_DIR);
  } catch {
    throw new Error(`Input folder not found: ${INPUT_DIR}. Create an "input" folder on the upload branch and put sprites/metadata inside it.`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`INPUT_DIR is not a directory: ${INPUT_DIR}`);
  }

  const zip = new JSZip();
  const count = await addInputFiles(zip, INPUT_DIR);

  if (!count) {
    throw new Error(`No input files found in ${INPUT_DIR}. Add PNG files and their matching atlas metadata.`);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 1 }
  });

  return { buffer, count };
}

async function extractOutputZip(zipBuffer, destination) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.values(zip.files);
  let outputCount = 0;
  let pngCount = 0;
  let metadataCount = 0;

  await fs.mkdir(destination, { recursive: true });

  for (const entry of entries) {
    if (entry.dir) continue;

    const normalized = path.posix.normalize(entry.name.replaceAll("\\", "/"));
    if (
      normalized.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error(`Unsafe path in optimizer output: ${entry.name}`);
    }

    const target = path.resolve(destination, ...normalized.split("/"));
    if (!target.startsWith(path.resolve(destination) + path.sep)) {
      throw new Error(`Output path escaped destination: ${entry.name}`);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async("nodebuffer"));

    outputCount++;
    const ext = path.posix.extname(normalized).toLowerCase();
    if (ext === ".png") pngCount++;
    if ([".xml", ".json", ".atlas", ".plist", ".tpsheet", ".tpset", ".css", ".paper2dsprites"].includes(ext)) {
      metadataCount++;
    }
  }

  if (!outputCount || !pngCount) {
    throw new Error(`Heroic Packer returned no usable PNG output (files: ${outputCount}, PNGs: ${pngCount}).`);
  }

  return { outputCount, pngCount, metadataCount };
}

async function main() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const { buffer: inputZip, count: inputFileCount } = await createInputZip();
  console.log(`Prepared ${inputFileCount} input files for Heroic Packer.`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const pageErrors = [];

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(({ options }) => {
      localStorage.setItem("t-packer-pack-options", JSON.stringify(options));
      localStorage.setItem("t-packer-language", "en");
    }, { options: PACK_OPTIONS });

    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on("pageerror", error => pageErrors.push(error.message));

    console.log(`Opening Heroic Packer at ${APP_URL}`);
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.locator(".main-header-bulk").waitFor({ state: "visible", timeout: 120_000 });

    await page.locator(".main-header-bulk").click();
    await page.locator(".bulk-overlay").waitFor({ state: "visible" });

    const upload = page.locator(".bulk-overlay input[type='file']").first();
    await upload.setInputFiles({
      name: "upload.zip",
      mimeType: "application/zip",
      buffer: inputZip
    });

    await page.waitForFunction(() => {
      const status = document.querySelector(".bulk-status")?.textContent?.trim() || "";
      return status.length > 0 && !/reading files/i.test(status);
    }, null, { timeout: 120_000 });

    const plan = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".bulk-list tbody tr"));
      const skipped = rows
        .filter(row => row.querySelector("td[colspan='2']"))
        .map(row => row.textContent?.trim() || "");
      const jobs = rows.filter(row => row.querySelectorAll("td").length === 2).length;
      return {
        jobs,
        skipped,
        status: document.querySelector(".bulk-status")?.textContent?.trim() || ""
      };
    });

    console.log(`Heroic Packer plan: ${plan.status}`);
    if (plan.skipped.length) {
      throw new Error(`Some input files were not recognized. Nothing will be published:\n${plan.skipped.join("\n")}`);
    }
    if (!plan.jobs) {
      throw new Error(`Heroic Packer found no valid sprite jobs. Status: ${plan.status}`);
    }

    const downloadPromise = page.waitForEvent("download", { timeout: TIMEOUT })
      .then(download => ({ download }))
      .catch(error => ({ error }));

    console.log(`Starting Optimal Packer for ${plan.jobs} job(s).`);
    await page.locator(".bulk-footer .btn").first().click();

    await page.waitForFunction(() => {
      const status = document.querySelector(".bulk-status")?.textContent?.trim() || "";
      return status.startsWith("Done:");
    }, null, { timeout: TIMEOUT });

    const errors = await page.locator(".bulk-list .bulk-error").allTextContents();
    if (errors.length) {
      throw new Error(`One or more packing jobs failed. Nothing will be published:\n${errors.join("\n")}`);
    }

    const footerButtons = await page.locator(".bulk-footer .btn").count();
    if (footerButtons < 3) {
      throw new Error("Heroic Packer finished without producing a downloadable output archive.");
    }

    let downloadResult = await downloadPromise;
    if (downloadResult.error) {
      console.log("Automatic download did not arrive; retrying with Download again.");
      const retryPromise = page.waitForEvent("download", { timeout: 5 * 60 * 1000 })
        .then(download => ({ download }))
        .catch(error => ({ error }));
      await page.locator(".bulk-footer .btn").filter({ hasText: "Download again" }).click();
      downloadResult = await retryPromise;
    }

    if (downloadResult.error) {
      throw new Error(`Could not retrieve Heroic Packer's output ZIP: ${downloadResult.error.message}`);
    }

    const zipPath = path.join(OUTPUT_DIR, "optimized.zip");
    await downloadResult.download.saveAs(zipPath);

    const zipBuffer = await fs.readFile(zipPath);
    const filesDir = path.join(OUTPUT_DIR, "files");
    const counts = await extractOutputZip(zipBuffer, filesDir);

    if (pageErrors.length) {
      throw new Error(`The Heroic Packer page reported runtime errors:\n${pageErrors.join("\n")}`);
    }

    const summary = {
      inputFileCount,
      jobCount: plan.jobs,
      outputFileCount: counts.outputCount,
      pngCount: counts.pngCount,
      metadataCount: counts.metadataCount,
      outputArchive: downloadResult.download.suggestedFilename(),
      settings: PACK_OPTIONS
    };

    await fs.writeFile(
      path.join(OUTPUT_DIR, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
      "utf8"
    );

    console.log("Optimization completed successfully.");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
  
