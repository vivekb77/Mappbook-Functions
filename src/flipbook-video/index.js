const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const chromium = require('@sparticuz/chromium');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase credentials are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Browser launch retry logic
async function launchBrowserWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Browser launch attempt ${attempt}/${maxRetries}`);
      
      const executablePath = await chromium.executablePath();
      console.log("Chrome executable path:", executablePath);
      
      const browser = await puppeteer.launch({
        args: chromium.args,
        executablePath,
        headless: chromium.headless,
        defaultViewport: chromium.defaultViewport,
        ignoreHTTPSErrors: true
      });
      
      console.log("Browser launched successfully");
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      console.log(`Waiting 5 seconds before retry ${attempt + 1}...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}
// Page initialization with retry logic
async function initializePage(browser, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // console.log(`Page initialization attempt ${attempt}/${maxRetries}`);
      
      const page = await browser.newPage();
      
      // Enhanced error logging
      page.on('error', err => console.error('Page ERROR:', err));
      page.on('pageerror', err => console.error('Page ERROR:', err));
      page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error' || text.includes('error') || text.includes('Error')) {
          // console.error('Browser Console ERROR:', text);
        } else {
          // console.log('Browser Console:', text);
        }
      });

      // Network request logging
      page.on('request', request => {
        console.log('Request:', request.url());
      });

      page.on('requestfailed', request => {
        console.error('Failed request:', {
          url: request.url(),
          errorText: request.failure().errorText,
          method: request.method(),
        });
      });

      page.on('response', response => {
        console.log('Response:', {
          url: response.url(),
          status: response.status(),
          headers: response.headers(),
        });
      });

      // Configure page settings
      // console.log('Setting timeouts and configurations...');
      await page.setDefaultNavigationTimeout(180000);
      await page.setDefaultTimeout(180000);
      
      // Disable cache but don't intercept requests
      await page.setCacheEnabled(false);
      
      // Set user agent to a modern browser
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // Set extra HTTP headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });

      console.log('Page initialized successfully');
      return page;
    } catch (error) {
      console.error(`Page initialization attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}


async function navigateToPage(page, url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Navigation attempt ${attempt}/${maxRetries} to ${url}`);

      // Wait for network idle before proceeding
      await page.goto(url, {
        waitUntil: ['networkidle0', 'domcontentloaded'],
        timeout: 180000,
      });

      // Check if the page was loaded successfully
      const content = await page.content();
      if (!content || content.includes('ERR_')) {
        throw new Error('Page loaded with errors');
      }

      // Wait for any initial JavaScript to execute
      await page.waitForFunction(() => {
        return document.readyState === 'complete' && 
               !document.querySelector('body.loading');
      }, { timeout: 30000 });

      console.log('Navigation successful');
      return true;
    } catch (error) {
      console.error(`Navigation attempt ${attempt} failed:`, error);
      
      // Log the page content on error
      try {
        const content = await page.content();
        console.log('Page content on error:', content);
      } catch (e) {
        console.error('Could not get page content:', e);
      }

      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}




// Screenshot capture with retry logic
async function captureScreenshot(page, frameFile, clipConfig, maxRetries = 3) {
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
  console.log(`Found ${pngFiles.length} PNG files for video processing`);
  
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
    if (frameNumbers[i] !== frameNumbers[i-1] + 1) {
      missingFrames.push(frameNumbers[i-1] + 1);
    }
  }
  
  if (missingFrames.length > 0) {
    console.warn('Missing frames detected:', missingFrames);
  }

  // Log first and last frame for verification
  console.log('First frame:', pngFiles[0]);
  console.log('Last frame:', pngFiles[pngFiles.length - 1]);

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
        console.log('FFmpeg command:', command);
      })
      .on('progress', (progressInfo) => {
        if (progressInfo.percent) {
          const newProgress = Math.floor(progressInfo.percent);
          if (newProgress > progress) {
            progress = newProgress;
            console.log(`Processing: ${progress}% done`, progressInfo);
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
          console.log('Output video metadata:', metadata);
          console.log('Video duration:', metadata.format.duration);
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

module.exports.handler = async (event) => {
  const { locationCount, mappbook_user_id } = event;
  const workDir = '/tmp';
  const framesDir = path.join(workDir, 'frames');
  const outputPath = path.join(workDir, 'output.mp4');
  let frameCount = 0;
  let browser;
  let page;
  let framesCaptureDone = false;

  console.log('Starting with params:', { locationCount, mappbook_user_id });

  try {
    // Use RAM disk for frames if available
    const useRamDisk = process.env.USE_RAMDISK === 'true';
    const effectiveFramesDir = useRamDisk ? '/dev/shm/frames' : framesDir;
    
    if (!fs.existsSync(effectiveFramesDir)) {
      fs.mkdirSync(effectiveFramesDir, { recursive: true });
    }

    // Launch browser with retry logic
    console.log('Launching browser...');
    browser = await launchBrowserWithRetry();
    
    // Initialize page with retry logic
    console.log('Initializing page...');
    page = await initializePage(browser);
    
    if (!page) {
      throw new Error('Page initialization failed to return a page object');
    }

    console.log('Page initialized successfully, proceeding with navigation...');

    const pageUrl = `${process.env.APP_URL}/playflipbook?userId=${mappbook_user_id}`;
    console.log('Navigating to:', pageUrl);

    await navigateToPage(page, pageUrl);

    // Wait for wooden background with enhanced error handling
    console.log('Waiting for wooden background...');
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
    const fps = 24;
    const secondsPerSpread = 1;
    const totalSpreads = Math.ceil((locationCount + 2) / 2);
    const batchSize = 5; // Process 5 frames at a time

    console.log(`Processing ${totalSpreads} spreads...`);

    // Inside the spread processing loop
// At the start of the main function, add:
let currentFrameNumber = 0; // This will ensure consecutive numbering

// In the frame processing loop, update the frame numbering:
for (let spread = 0; spread < totalSpreads; spread++) {
  console.log(`Processing spread ${spread + 1}/${totalSpreads}`);
  
  const framesNeeded = fps * secondsPerSpread;
  console.log(`Capturing ${framesNeeded} frames for spread ${spread + 1}`);
  
  for (let i = 0; i < framesNeeded; i += batchSize) {
    const promises = [];
    
    for (let j = 0; j < batchSize && (i + j) < framesNeeded; j++) {
      currentFrameNumber++; // Increment frame number sequentially
      const frameFile = path.join(
        effectiveFramesDir,
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
            console.log(`Captured frame ${currentFrameNumber}`);
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
    const filesAfterBatch = fs.readdirSync(effectiveFramesDir)
      .filter(f => f.endsWith('.png'))
      .sort();
    console.log(`PNG files in directory after batch:`, filesAfterBatch.length);
    console.log('Last frame in batch:', filesAfterBatch[filesAfterBatch.length - 1]);
  }

  if (spread < totalSpreads - 1) {
    console.log(`Looking for flip button after spread ${spread + 1}...`);
    
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
    
    console.log('Page state:', pageState);
  
    let flipButtonFound = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Flip button attempt ${attempt}/3`);
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
        
        console.log('Flip button clicked successfully');
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
      await processVideo(effectiveFramesDir, outputPath, fps);

      console.log('Video processing complete, uploading to Supabase...');
      const videoBuffer = fs.readFileSync(outputPath);
      const videoFileName = `flipbook_${mappbook_user_id}_${Date.now()}.mp4`;
      
      // Upload with retry logic
      let uploadAttempt = 0;
      let uploadSuccess = false;
      
      while (!uploadSuccess && uploadAttempt < 3) {
        try {
          console.log(`Upload attempt ${uploadAttempt + 1}/3`);
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
          console.log('Inserting record into database...');
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
              console.error(`Database insert attempt ${dbAttempt} failed:`, error);
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
    console.log('Starting cleanup...');
    try {
      if (browser) {
        console.log('Closing browser in cleanup...');
        await browser.close().catch(e => console.error('Error closing browser:', e));
      }
      
      if (fs.existsSync(framesDir)) {
        console.log('Removing frames directory...');
        fs.rmSync(framesDir, { recursive: true, force: true });
      }
      
      if (fs.existsSync(outputPath)) {
        console.log('Removing output video file...');
        fs.unlinkSync(outputPath);
      }
      
      console.log('Cleanup completed');
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
};