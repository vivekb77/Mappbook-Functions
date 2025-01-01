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

async function captureVideo(url, outputPath) {
  let browser = null;
  let page = null;
  const monitor = new ResourceMonitor();
  const stream = new PassThrough();
  const RECORDING_DURATION = 60000; // 1 minute
  const TARGET_FPS = 12; // Reduced target FPS to be more realistic for Lambda

  try {
    // Browser setup remains the same...
    browser = await chromium.puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--single-process'],
      defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      executablePath: await chromium.executablePath,
      headless: chromium.headless
    });

    page = await browser.newPage();
    console.log('Navigating to page...');
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    await waitForMapLoad(page);
    const mapElement = await page.waitForSelector('div[class*="mapboxgl-map"]');
    console.log('Map element found');

    // Initialize FFmpeg with lower FPS target
    const ffmpegCommand = ffmpeg()
      .input(stream)
      .inputFormat('jpeg_pipe')
      .inputFPS(TARGET_FPS)
      .videoCodec('libx264')
      .outputOptions([
        '-preset ultrafast',
        '-pix_fmt yuv420p',
        '-profile:v baseline',
        '-level 3.0',
        '-maxrate 2000k',
        '-bufsize 4000k',
        '-crf 28',
        '-g 12'
      ])
      .output(outputPath);

    const ffmpegPromise = new Promise((resolve, reject) => {
      ffmpegCommand.on('end', resolve).on('error', reject);
    });

    ffmpegCommand.run();
    console.log('FFmpeg started');

    // Start flight
    const startFlightButton = await page.waitForSelector('[data-testid="start-flight-button"]', {
      timeout: 5000,
      visible: true
    });
    await startFlightButton.click();
    console.log('Flight started');

    const startTime = Date.now();
    let frameCount = 0;

    // Capture frames as fast as possible
    while (Date.now() - startTime < RECORDING_DURATION) {
      if (!monitor.check()) break;

      try {
        const screenshot = await mapElement.screenshot({
          type: 'jpeg',
          quality: 70  // Further reduced quality
        });

        const success = stream.write(screenshot);
        if (!success) {
          await new Promise(resolve => stream.once('drain', resolve));
        }

        frameCount++;
        
        if (frameCount % 10 === 0) {
          console.log(`Captured ${frameCount} frames, elapsed: ${((Date.now() - startTime)/1000).toFixed(1)}s`);
        }

      } catch (error) {
        console.error('Frame capture error:', error);
        continue;
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`Capture complete: ${frameCount} frames over ${totalTime} seconds`);

    stream.end();
    console.log('Waiting for FFmpeg...');
    await ffmpegPromise;

    const stats = await fs.stat(outputPath);
    console.log(`Video file created: ${stats.size} bytes`);

    if (stats.size < 1000) {
      throw new Error(`Video file too small: ${stats.size} bytes`);
    }

    return async () => {
      if (page) await page.close().catch(console.error);
      if (browser) await browser.close().catch(console.error);
    };

  } catch (error) {
    console.error('Capture error:', error);
    if (page) await page.close().catch(console.error);
    if (browser) await browser.close().catch(console.error);
    stream.destroy();
    throw error;
  }
}

module.exports.handler = async (event) => {
  let cleanup = null;
  let animation_video_id = null;

  try {
    if (!event.body) {
      throw new Error('Missing request body');
    }

    const parsedBody = JSON.parse(event.body);
    const { animation_video_id: videoId } = parsedBody;
    animation_video_id = videoId; // Store in outer scope for catch block

    console.log('Animation video id is - '+animation_video_id)

    if ( !animation_video_id) {
      throw new Error('Missing required parameters: animation_video_id');
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
      .from('map-animation-videos')
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
    
    // Only attempt to update the record if we have a valid animation_video_id
    if (animation_video_id) {
      try {
        await supabase
          .from('Animation_Video')
          .update({
            video_generation_status: false,
            error_message: error.message // Optional: store error message
          })
          .eq('animation_video_id', animation_video_id);
      } catch (updateError) {
        console.error('Failed to update error status:', updateError);
      }
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