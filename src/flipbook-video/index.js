// const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const chromium = require('chrome-aws-lambda');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase credentials are required');
}
const DEFAULT_LAMBDA_CONFIG = {
  maxRetries: 2,
  timeout: 500000,
  retryDelay: 1000,
  maxMemoryMB: 2048,
  debugLogging: process.env.DEBUG === 'true'
};

const supabase = createClient(supabaseUrl, supabaseKey);

function getWorkingDirectory() {
  const tmpDir = '/tmp';
  const shmDir = '/dev/shm';

  const testShmAccess = () => {
    try {
      const testDir = `${shmDir}/test-${Date.now()}`;
      fs.mkdirSync(testDir, { recursive: true });
      fs.rmdirSync(testDir);
      return true;
    } catch (error) {
      console.warn('SharedMemory (/dev/shm) not accessible:', error.message);
      return false;
    }
  };

  if (process.env.USE_RAMDISK === 'true' && testShmAccess()) {
    try {
      const uniqueDir = `${shmDir}/lambda-${Date.now()}`;
      fs.mkdirSync(uniqueDir, { recursive: true, mode: 0o777 });
      // console.log('Successfully created directory in SharedMemory:', uniqueDir);
      return uniqueDir;
    } catch (error) {
      console.error('Failed to create directory in SharedMemory:', error);
    }
  }

  const uniqueTmpDir = `${tmpDir}/lambda-${Date.now()}`;
  fs.mkdirSync(uniqueTmpDir, { recursive: true, mode: 0o777 });
  // console.log('Using temporary directory:', uniqueTmpDir);
  return uniqueTmpDir;
}


async function launchBrowserWithRetry(maxRetries = 2) {
  let browser;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Don't need the process cleanup anymore since we're using chrome-aws-lambda
      // Remove the pkill commands as they can interfere with chrome-aws-lambda's management

      if (global.gc) global.gc();

      browser = await chromium.puppeteer.launch({
        args: [
          ...chromium.args,
          '--disable-web-security',
          '--disable-features=IsolateOrigins',
          '--disable-site-isolation-trials',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
        protocolTimeout: 300000,
        
        browserWSEndpoint: undefined,
      });

      browser.on('disconnected', () => {
        console.error('Browser disconnected', {
          timestamp: new Date().toISOString(),
          memory: process.memoryUsage()
        });
      });

      // Verify browser is working
      const pages = await browser.pages();
      if (!pages || pages.length === 0) {
        throw new Error('Browser launched but no pages available');
      }

      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${attempt} failed:`, {
        attempt,
        error: error.message,
        stack: error.stack,
        memory: process.memoryUsage()
      });

      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          console.error('Error closing browser:', e);
        }
      }

      if (attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function createPage(browser) {
  const page = await browser.newPage();

  // Enhanced error handling
  page.on('error', err => console.error('Page error:', err));
  page.on('pageerror', err => console.error('Page error:', err));
  // page.on('console', msg => console.log('Page console:', msg.text()));

  // Optimize page performance
  await page.setDefaultNavigationTimeout(30000);
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    request.continue();
  });

  return page;
}

async function navigateWithRetry(page, url, options = {}) {
  const config = { ...DEFAULT_LAMBDA_CONFIG, ...options };
  const metrics = { attempts: 0, errors: [] };

  // Monitor memory usage
  const memoryCheckInterval = setInterval(() => {
    const usedMemoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (usedMemoryMB > config.maxMemoryMB) {
      console.warn(`High memory usage: ${usedMemoryMB.toFixed(2)}MB`);
    }
  }, 1000);

  try {
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      metrics.attempts++;

      try {
        // Verify browser and page state before navigation
        const browser = page.browser();
        if (!browser?.isConnected()) {
          throw new Error('Browser disconnected before navigation');
        }

        // Check if page is still valid
        if (page.isClosed()) {
          throw new Error('Page was closed before navigation');
        }

        // Clear memory and prepare for navigation
        await Promise.race([
          page.evaluate(() => {
            window.stop();
            if (typeof window.gc === 'function') window.gc();
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Memory cleanup timeout')), 5000)
          )
        ]);

        // Set conservative timeouts for Lambda
        await page.setDefaultNavigationTimeout(config.timeout);
        await page.setDefaultTimeout(config.timeout);

        // Attempt navigation with more detailed error capture
        const response = await Promise.race([
          page.goto(url, {
            waitUntil: ['domcontentloaded'], // More conservative wait condition
            timeout: config.timeout
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Navigation timeout')), config.timeout)
          )
        ]);

        if (!response) {
          throw new Error('Navigation returned no response');
        }

        // Verify the response and page state
        const status = response.status();
        const pageTitle = await page.title().catch(() => 'Unable to get title');

        if (status >= 400) {
          throw new Error(`HTTP error status: ${status}, Page title: ${pageTitle}`);
        }

        // console.log({
        //   event: 'navigation_success',
        //   attempt,
        //   url,
        //   status,
        //   title: pageTitle,
        //   metrics
        // });

        return response;

      } catch (error) {
        metrics.errors.push({
          attempt,
          message: error.message,
          type: error.constructor.name,
          timestamp: new Date().toISOString()
        });

        console.error({
          event: 'navigation_error',
          attempt,
          url,
          error: {
            message: error.message,
            type: error.constructor.name,
            stack: error.stack
          },
          metrics,
          memoryUsage: process.memoryUsage()
        });

        // If this is a target/connection error, check browser state
        if (error.message.includes('Target closed') ||
          error.message.includes('Protocol error')) {

          // Check if browser is still alive
          const browser = page.browser();
          if (!browser?.isConnected()) {
            throw new Error('Browser connection lost - terminating navigation attempts');
          }

          // Check if page is still valid
          if (page.isClosed()) {
            throw new Error('Page was closed - terminating navigation attempts');
          }
        }

        if (attempt === config.maxRetries) {
          throw new Error(`Navigation failed after ${attempt} attempts: ${error.message}`);
        }

        // Shorter delays between retries in Lambda
        await new Promise(r => setTimeout(r, config.retryDelay));
      }
    }
  } finally {
    clearInterval(memoryCheckInterval);
  }
}

// Screenshot capture with retry logic
async function captureScreenshot(page, frameFile, clipConfig, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.screenshot({
        path: frameFile,
        type: 'png',
        clip: clipConfig,
      });
      return true;
    } catch (error) {
      console.error(`Screenshot attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
    }
  }
}

async function processVideo(framesDir, outputPath, fps) {
  // First verify we have enough frames
  const files = fs.readdirSync(framesDir);
  const pngFiles = files.filter(f => f.endsWith('.png'));
  // console.log(`Found ${pngFiles.length} PNG files for video processing`);

  if (pngFiles.length === 0) {
    throw new Error('No frames found for video processing');
  }

  // Sort files to ensure correct order
  pngFiles.sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)[0]);
    const numB = parseInt(b.match(/\d+/)[0]);
    return numA - numB;
  });

  // Verify frame sequence
  const frameNumbers = pngFiles.map(f => parseInt(f.match(/\d+/)[0]));
  const missingFrames = [];
  for (let i = 1; i < frameNumbers.length; i++) {
    if (frameNumbers[i] !== frameNumbers[i - 1] + 1) {
      missingFrames.push(frameNumbers[i - 1] + 1);
    }
  }

  if (missingFrames.length > 0) {
    console.warn('Missing frames detected:', missingFrames);
  }

  // Log first and last frame for verification
  // console.log('First frame:', pngFiles[0]);
  // console.log('Last frame:', pngFiles[pngFiles.length - 1]);

  return new Promise((resolve, reject) => {
    let progress = 0;
    const ffmpegCommand = ffmpeg()
      .input(path.join(framesDir, 'frame_%06d.png'))
      .inputFPS(fps)
      .videoCodec('libx264')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-preset ultrafast',
        '-crf 23',
        '-movflags +faststart',
        // Force the input framerate
        '-r', `${fps}`,
        // Ensure all frames are included
        '-frames:v', `${pngFiles.length}`,
        // Verify video duration
        '-t', `${pngFiles.length / fps}`
      ])
      .output(outputPath)
      .on('start', command => {
        // console.log('FFmpeg command:', command);
      })
      .on('progress', (progressInfo) => {
        if (progressInfo.percent) {
          const newProgress = Math.floor(progressInfo.percent);
          if (newProgress > progress) {
            progress = newProgress;
            // console.log(`Processing: ${progress}% done`, progressInfo);
          }
        }
      })
      .on('end', () => {
        // Verify the output video
        ffmpeg.ffprobe(outputPath, (err, metadata) => {
          if (err) {
            console.error('Error probing output video:', err);
            return reject(err);
          }
          // console.log('Output video metadata:', metadata);
          // console.log('Video duration:', metadata.format.duration);
          resolve();
        });
      })
      .on('error', (err) => {
        console.error('Error during video processing:', err);
        reject(err);
      });

    ffmpegCommand.run();
  });
}

async function performGarbageCollection() {
  if (global.gc) {
    global.gc();
  }
  // Force V8 garbage collection
  await new Promise(resolve => setTimeout(resolve, 100));
}

module.exports.handler = async (event) => {

  if (!event.body || typeof event.body !== 'string') {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: false,
        error: 'Missing or invalid request body'
      })
    };
  }

  const { locationCount, mappbook_user_id, passport_display_name, is_passport_video_premium_user } = JSON.parse(event.body);
  const baseDir = getWorkingDirectory();
  const framesDir = path.join(baseDir, 'frames');
  const outputPath = path.join(baseDir, 'output.mp4');
  let browser = null;
  let page = null;


  try {
    fs.mkdirSync(framesDir, { recursive: true, mode: 0o777 });

    // Launch browser with enhanced configuration
    browser = await launchBrowserWithRetry(3);
    // console.log('Browser launched successfully');
    browserKeepAlive = setInterval(async () => {
      try {
        const pages = await browser.pages();
        if (!pages || !browser.isConnected()) {
          throw new Error('Browser connection lost');
        }
      } catch (error) {
        console.error('Browser keepalive check failed:', error);
      }
    }, 30000);
    // Create page with optimized settings
    page = await createPage(browser);
    console.log('Page created successfully');

    const pageUrl = `${process.env.APP_URL}/playflipbook?userId=${mappbook_user_id}&displayname=${passport_display_name}&isPremium=${is_passport_video_premium_user}`;

    // Navigate with enhanced error handling
    await navigateWithRetry(page, pageUrl, {
      maxRetries: 2,
      timeout: 30000,
      retryDelay: 2000
    });

    // Wait for wooden background with enhanced error handling
    // console.log('Waiting for wooden background...');
    let woodenElement;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        woodenElement = await page.waitForSelector('[data-testid="wooden-background"]', {
          timeout: 30000,
          visible: true
        });

        // Verify element visibility
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';
        }, woodenElement);

        if (!isVisible) {
          throw new Error('Wooden background element is not visible');
        }

        console.log('Wooden background found and visible');
        break;
      } catch (error) {
        console.error(`Wooden background detection attempt ${attempt} failed:`, error);
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    const woodenBounds = await woodenElement.boundingBox();

    if (!woodenBounds) {
      throw new Error('Could not get wooden container bounds');
    }

    const width = Math.floor(woodenBounds.width / 2) * 2;
    const height = Math.floor(woodenBounds.height / 2) * 2;



    // Batch process frames
    const fps = 14;
    const secondsPerSpread = 2;

    let effectiveLocationCount;
    if (is_passport_video_premium_user) {
      effectiveLocationCount = locationCount;
    } else {
      effectiveLocationCount = Math.min(locationCount, 5); // Limit to 5 locations for non-premium users
    }

    const totalSpreads = Math.ceil((effectiveLocationCount + 2) / 2);

    const batchSize = 3; // Process 5 frames at a time

    // console.log(`Processing ${totalSpreads} spreads...`);

    // Inside the spread processing loop
    // At the start of the main function, add:
    let currentFrameNumber = 0; // This will ensure consecutive numbering

    // In the frame processing loop, update the frame numbering:
    for (let spread = 0; spread < totalSpreads; spread++) {
      console.log(`Processing spread ${spread + 1}/${totalSpreads}`);
      if (spread % 2 === 0) {
        await performGarbageCollection();
      }
      const framesNeeded = fps * secondsPerSpread;
      // console.log(`Capturing ${framesNeeded} frames for spread ${spread + 1}`);

      for (let i = 0; i < framesNeeded; i += batchSize) {
        const promises = [];

        for (let j = 0; j < batchSize && (i + j) < framesNeeded; j++) {
          currentFrameNumber++; // Increment frame number sequentially
          const frameFile = path.join(
            framesDir,
            `frame_${currentFrameNumber.toString().padStart(6, '0')}.png`
          );

          const clipConfig = {
            x: woodenBounds.x,
            y: woodenBounds.y,
            width,
            height,
          };

          promises.push(
            captureScreenshot(page, frameFile, clipConfig)
              .then(() => {
                // console.log(`Captured frame ${currentFrameNumber}`);
                return currentFrameNumber;
              })
              .catch(error => {
                console.error(`Error capturing frame ${currentFrameNumber}:`, error);
                throw error;
              })
          );
        }

        await Promise.all(promises);
        // Verify frames were created
        const filesAfterBatch = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.png'))
          .sort();
        // console.log(`PNG files in directory after batch:`, filesAfterBatch.length);
        // console.log('Last frame in batch:', filesAfterBatch[filesAfterBatch.length - 1]);
      }

      if (spread < totalSpreads - 1) {
        // console.log(`Looking for flip button after spread ${spread + 1}...`);

        // First verify the page state
        const pageState = await page.evaluate(() => {
          const button = document.querySelector('[data-testid="flip-button"]');
          return {
            buttonExists: !!button,
            buttonVisible: button ? window.getComputedStyle(button).display !== 'none' : false,
            buttonHTML: button ? button.outerHTML : null,
            bodyHTML: document.body.innerHTML.substring(0, 1000)
          };
        });

        // console.log('Page state:', pageState);

        let flipButtonFound = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // console.log(`Flip button attempt ${attempt}/3`);
            const flipButton = await page.waitForSelector('[data-testid="flip-button"]', {
              timeout: 30000,
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

            console.log('Flip button found and clickable, attempting click...');
            await flipButton.click();
            flipButtonFound = true;

            // Use delay instead of waitForTimeout
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Wait for any animation or state change
            await page.waitForFunction(() => {
              const button = document.querySelector('[data-testid="flip-button"]');
              return button && !button.disabled;
            }, { timeout: 5000 });

            // console.log('Flip button clicked successfully');
            break;
          } catch (error) {
            console.error(`Flip attempt ${attempt} failed:`, error);
            if (attempt === 3) {
              console.error('All flip attempts failed, dumping page content...');
              const content = await page.content();
              console.log('Page content:', content);
              throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        if (!flipButtonFound) {
          throw new Error('Could not find or click flip button after all attempts');
        }
      }
    }

    // Mark frames capture as complete
    framesCaptureDone = true;

    // Close browser after frame capture
    if (browser) {
      console.log('Closing browser after frame capture...');
      await browser.close();
      browser = null;
    }

    // Process video if frames were captured successfully
    if (framesCaptureDone) {
      console.log('Starting video processing...');
      await processVideo(framesDir, outputPath, fps);

      // console.log('Video processing complete, uploading to Supabase...');
      const videoBuffer = fs.readFileSync(outputPath);
      const videoFileName = `flipbook_${mappbook_user_id}_${Date.now()}.mp4`;

      // Upload with retry logic
      let uploadAttempt = 0;
      let uploadSuccess = false;

      while (!uploadSuccess && uploadAttempt < 3) {
        try {
          // console.log(`Upload attempt ${uploadAttempt + 1}/3`);
          const { data, error } = await supabase
            .storage
            .from('flipbook-videos')
            .upload(videoFileName, videoBuffer, {
              contentType: 'video/mp4',
              upsert: true
            });

          if (error) throw error;
          uploadSuccess = true;

          const { data: { publicUrl } } = supabase
            .storage
            .from('flipbook-videos')
            .getPublicUrl(videoFileName);

          // Database insert with retry
          // console.log('Inserting record into database...');
          let dbAttempt = 0;
          let dbSuccess = false;

          while (!dbSuccess && dbAttempt < 3) {
            try {
              await supabase
                .from('FlipBook_Video')
                .insert({
                  mappbook_user_id,
                  video_url: publicUrl,
                  location_count: locationCount,
                  is_deleted: false
                });
              dbSuccess = true;
              console.log('Database insert successful');
            } catch (error) {
              dbAttempt++;
              // console.error(`Database insert attempt ${dbAttempt} failed:`, error);
              if (dbAttempt === 3) throw error;
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }

          return {
            statusCode: 200,
            body: JSON.stringify({
              success: true,
              video_url: publicUrl
            }),
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          };
        } catch (error) {
          console.error('Processing failed:', error);
          return {
            statusCode: 500,
            body: JSON.stringify({
              success: false,
              error: error.message
            }),
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          };
        }
      }
    } else {
      throw new Error('Frame capture was not completed successfully');
    }

  } catch (error) {
    console.error('Processing failed:', error);
    throw error;
  } finally {
    // Cleanup resources
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.error('Error closing page:', e);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }

    // Cleanup temporary directories
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (e) {
      console.error('Error cleaning up directory:', e);
    }

    if (browserKeepAlive) {
      clearInterval(browserKeepAlive);
    }
  }
};