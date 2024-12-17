const { createClient } = require('@supabase/supabase-js');
const chromium = require('chrome-aws-lambda');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const { PassThrough } = require('stream');
const os = require('os');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase credentials are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Configure limits
const MEMORY_LIMIT = parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || '1024', 10);
const MEMORY_BUFFER = 128; // MB to keep free
const MAX_FRAMES = 300; // Limit total frames

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

    if (Date.now() - this.startTime > 840000) { // 14 minutes
      throw new Error('Time limit approaching');
    }

    this.frameCount++;
    if (this.frameCount > MAX_FRAMES) {
      throw new Error(`Frame limit exceeded: ${this.frameCount}`);
    }

    return true;
  }
}

async function captureVideo(url, outputPath) {
  let browser = null;
  let page = null;
  const monitor = new ResourceMonitor();
  const stream = new PassThrough();

  try {
    // Create FFmpeg command with proper event handling
    const ffmpegCommand = ffmpeg()
      .input(stream)
      .inputFormat('jpeg_pipe')
      .fps(10)
      .size('1280x720')
      .videoCodec('libx264')
      .outputOptions([
        '-preset ultrafast',
        '-pix_fmt yuv420p',
        '-profile:v baseline',
        '-level 3.0',
        '-maxrate 2000k',
        '-bufsize 4000k',
        '-crf 28',
        '-g 10'
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

    // Wait for the wooden background to be visible
    await page.waitForSelector('[data-testid="wooden-background"]', {
      timeout: 30000,
      visible: true
    });

    // Set up frame capture
    let frameCount = 0;
    while (frameCount < MAX_FRAMES) {
      if (!monitor.check()) break;

      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 70
      });

      const success = stream.write(screenshot);
      if (!success) {
        await new Promise(resolve => stream.once('drain', resolve));
      }

      frameCount++;
      await new Promise(resolve => setTimeout(resolve, 100)); // 10 FPS
    }

    // Close the stream and wait for FFmpeg to finish
    stream.end();
    console.log(`Captured ${frameCount} frames, waiting for FFmpeg to finish...`);
    await ffmpegPromise;

    // Verify the file exists and has content
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

    const { locationCount, mappbook_user_id, passport_display_name, is_passport_video_premium_user } = JSON.parse(event.body);
    
    const outputPath = path.join('/tmp', `output-${Date.now()}.mp4`);
    const pageUrl = `${process.env.APP_URL}/playflipbook?userId=${mappbook_user_id}&displayname=${passport_display_name}&isPremium=${is_passport_video_premium_user}`;

    console.log('Starting video capture...', { outputPath, pageUrl });
    cleanup = await captureVideo(pageUrl, outputPath);

    // Verify the file exists after capture
    try {
      const stats = await fs.stat(outputPath);
      console.log(`Video file size: ${stats.size} bytes`);
      if (stats.size < 1000) {
        throw new Error(`Video file too small: ${stats.size} bytes`);
      }
    } catch (error) {
      console.error('Video file verification failed:', error);
      throw new Error(`Video creation failed: ${error.message}`);
    }

    // Read and upload video
    const videoBuffer = await fs.readFile(outputPath);
    const videoFileName = `flipbook_${mappbook_user_id}_${Date.now()}.mp4`;

    console.log('Uploading video to Supabase...');
    const { data, error } = await supabase
      .storage
      .from('flipbook-videos')
      .upload(videoFileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const { data: { publicUrl } } = supabase
      .storage
      .from('flipbook-videos')
      .getPublicUrl(videoFileName);

    await supabase
      .from('FlipBook_Video')
      .insert({
        mappbook_user_id,
        video_url: publicUrl,
        location_count: locationCount,
        is_deleted: false
      });

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