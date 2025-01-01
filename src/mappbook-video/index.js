const { createClient } = require('@supabase/supabase-js');
const chromium = require('chrome-aws-lambda');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const { PassThrough } = require('stream');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase credentials are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Configure limits
const MEMORY_LIMIT = parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || '1024', 10);
const MEMORY_BUFFER = 128;
const FPS = 24;
const SECONDS_PER_SPREAD = 2.5;

class ResourceMonitor {
  constructor(warningThreshold = 0.8) {
    this.warningThreshold = warningThreshold;
    this.startTime = Date.now();
    this.frameCount = 0;
  }

  check() {
    const memoryUsage = process.memoryUsage();
    const usedMemoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const memoryLimitMB = MEMORY_LIMIT - MEMORY_BUFFER;

    if (usedMemoryMB > memoryLimitMB * this.warningThreshold) {
      throw new Error(`Memory threshold exceeded: ${usedMemoryMB}MB used of ${memoryLimitMB}MB limit`);
    }

    if (Date.now() - this.startTime > 840000) {
      throw new Error('Time limit approaching');
    }

    this.frameCount++;
    return true;
  }
}

async function waitForMapLoad(page) {
  await page.waitForFunction(
    () => {
      const map = document.querySelector('div[class*="mapboxgl-map"]');
      return map && !map.classList.contains('mapboxgl-map--loading');
    },
    { timeout: 30000 }
  );
}

async function waitForElement(page, selector, options = {}) {
  const element = await page.waitForSelector(selector, {
    visible: true,
    timeout: 30000,
    ...options
  });
  return element;
}

async function captureVideo(url, outputPath) {
  let browser = null;
  let page = null;
  const monitor = new ResourceMonitor();
  const stream = new PassThrough();

  try {
    browser = await chromium.puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--single-process'
      ],
      defaultViewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      },
      executablePath: await chromium.executablePath,
      headless: chromium.headless
    });

    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for map and controls to be ready
    await waitForMapLoad(page);
    // await waitForElement(page, '[data-testid="wooden-background"]');
    
    // Wait for animation data to load
    // await page.waitForFunction(
    //   () => !document.querySelector('.loading-animation'),
    //   { timeout: 30000 }
    // );

    // Find and click the Start Flight button
    const startFlightButton = await waitForElement(page, 'button:has-text("Start Flight")');
    await startFlightButton.click();

    // Create FFmpeg command
    const ffmpegCommand = ffmpeg()
      .input(stream)
      .inputFormat('jpeg_pipe')
      .inputFPS(FPS)
      .videoCodec('libx264')
      .outputOptions([
        '-preset medium',
        '-pix_fmt yuv420p',
        '-profile:v high',
        '-level 4.0',
        '-maxrate 4000k',
        '-bufsize 8000k',
        '-crf 23',
        '-g 14'
      ])
      .output(outputPath);

    // Create a promise to track FFmpeg completion
    const ffmpegPromise = new Promise((resolve, reject) => {
      ffmpegCommand
        .on('end', () => {
          console.log('FFmpeg processing finished');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        });
    });

    // Start the FFmpeg process
    ffmpegCommand.run();

    // Wait for animation to complete
    await page.waitForFunction(
      () => !document.querySelector('button:has-text("Cancel Flight")'),
      { timeout: 120000 } // 2 minute timeout for animation
    );

    // Get the wooden background element for screenshots
    const woodenElement = await page.waitForSelector('div[class*="mapboxgl-map"]');

    // Capture the final state
    const screenshot = await woodenElement.screenshot({
      type: 'jpeg',
      quality: 100
    });
    stream.write(screenshot);
    stream.end();

    console.log('Waiting for FFmpeg to finish...');
    await ffmpegPromise;

    const stats = await fs.stat(outputPath);
    if (stats.size < 1000) {
      throw new Error(`Video file too small: ${stats.size} bytes`);
    }

    return async () => {
      if (page) await page.close().catch(console.error);
      if (browser) await browser.close().catch(console.error);
    };
  } catch (error) {
    if (page) await page.close().catch(console.error);
    if (browser) await browser.close().catch(console.error);
    stream.destroy();
    throw error;
  }
}

module.exports.handler = async (event) => {
  let cleanup = null;

  try {
    if (!event.body) {
      throw new Error('Missing request body');
    }

    const { mappbook_user_id, animation_video_id } = JSON.parse(event.body);

    if (!mappbook_user_id || !animation_video_id) {
      throw new Error('Missing required parameters: mappbook_user_id and animation_video_id');
    }

    const outputPath = path.join('/tmp', `output-${Date.now()}.mp4`);
    const pageUrl = `${process.env.APP_URL}/render/${animation_video_id}`;

    console.log('Starting video capture...', { outputPath, pageUrl });
    cleanup = await captureVideo(pageUrl, outputPath);

    // Read and upload video
    const videoBuffer = await fs.readFile(outputPath);
    const videoFileName = `animation_${animation_video_id}_${Date.now()}.mp4`;

    console.log('Uploading video to Supabase...');
    const { data, error } = await supabase
      .storage
      .from('animation-videos')
      .upload(videoFileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const { data: { publicUrl } } = supabase
      .storage
      .from('map-animation-videos')
      .getPublicUrl(videoFileName);

    // Update the Animation_Video record
    await supabase
      .from('Animation_Video')
      .update({
        video_url: publicUrl,
        video_generation_status: true,
      })
      .eq('animation_video_id', animation_video_id);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        video_url: publicUrl
      })
    };

  } catch (error) {
    console.error('Handler failed:', error);
    
    // Update the Animation_Video record with error status
    if (animation_video_id) {
      await supabase
        .from('Animation_Video')
        .update({
          video_generation_status: false,
        })
        .eq('animation_video_id', animation_video_id);
    }

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  } finally {
    if (cleanup) {
      await cleanup().catch(console.error);
    }

    // Clean up temp files
    try {
      const files = await fs.readdir('/tmp');
      await Promise.all(
        files
          .filter(file => file.startsWith('output-'))
          .map(file => fs.unlink(path.join('/tmp', file)).catch(console.error))
      );
    } catch (error) {
      console.error('Temp file cleanup failed:', error);
    }
  }
};