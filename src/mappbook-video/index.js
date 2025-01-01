//index.js
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
const FPS = 24; // Frames per second
const SECONDS_PER_SPREAD = 2.5; // Time to show each spread

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
    return true;
  }
}

async function captureVideo(url, outputPath, locationCount, isPremium) {
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

    // Wait for the wooden background to be visible and get its dimensions
    const woodenElement = await page.waitForSelector('[data-testid="wooden-background"]', {
      timeout: 30000,
      visible: true
    });


    // Create FFmpeg command with wooden background dimensions
    const ffmpegCommand = ffmpeg()
      .input(stream)
      .inputFormat('jpeg_pipe')
      .inputFPS(FPS)
      .videoCodec('libx264')
      // .size(`${clipConfig.width}x${clipConfig.height}`) // Set size to match wooden background
      .outputOptions([
        '-preset medium',     // Change from ultrafast to medium for better quality
        '-pix_fmt yuv420p',
        '-profile:v high',    // Change from baseline to high profile
        '-level 4.0',         // Increase level
        '-maxrate 4000k',     // Increase from 2000k
        '-bufsize 8000k',     // Increase from 4000k
        '-crf 23',           // Lower CRF value (23 instead of 28) for better quality
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

    // Calculate total spreads based on location count and premium status

    const effectiveLocationCount = isPremium ? locationCount : Math.min(locationCount, 5);
    const totalSpreads = Math.ceil((effectiveLocationCount + 4) / 2) + 2;

    // Calculate frames needed per spread
    const framesPerSpread = FPS * SECONDS_PER_SPREAD;

    // Process each spread
    for (let spread = 0; spread < totalSpreads; spread++) {
      console.log(`Processing spread ${spread + 1}/${totalSpreads}`);

      // Capture frames for current spread
      for (let frame = 0; frame < framesPerSpread; frame++) {
        if (!monitor.check()) break;

        // Screenshot only the wooden background area
        // const screenshot = await page.screenshot({
        //   type: 'jpeg',
        //   quality: 80,
        //   clip: clipConfig
        // });

        const screenshot = await woodenElement.screenshot({
          type: 'jpeg',
          quality: 100
        });

        const success = stream.write(screenshot);
        if (!success) {
          await new Promise(resolve => stream.once('drain', resolve));
        }

        // Small delay between frames
        await new Promise(resolve => setTimeout(resolve, 1000 / FPS));
      }

      // If not the last spread, click the flip button
      if (spread < totalSpreads - 1) {
        console.log(`Flipping to next spread...`);

        let flipButtonFound = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const flipButton = await page.waitForSelector('[data-testid="flip-button"]', {
              timeout: 5000,
              visible: true
            });

            // Verify button is clickable
            const buttonEnabled = await page.evaluate(button => {
              const style = window.getComputedStyle(button);
              return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                !button.disabled;
            }, flipButton);

            if (!buttonEnabled) {
              throw new Error('Flip button found but not clickable');
            }

            await flipButton.click();
            flipButtonFound = true;

            // Wait for flip animation
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Wait for button to be ready again
            await page.waitForFunction(() => {
              const button = document.querySelector('[data-testid="flip-button"]');
              return button && !button.disabled;
            }, { timeout: 5000 });

            break;
          } catch (error) {
            console.error(`Flip attempt ${attempt} failed:`, error);
            if (attempt === 3) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        if (!flipButtonFound) {
          throw new Error('Could not find or click flip button after all attempts');
        }
      }
    }

    // Close the stream and wait for FFmpeg to finish
    stream.end();
    console.log(`Captured frames for ${totalSpreads} spreads (${monitor.frameCount} total frames), waiting for FFmpeg to finish...`);
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
    cleanup = await captureVideo(pageUrl, outputPath, locationCount, is_passport_video_premium_user);

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