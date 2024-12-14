# Stage 1: Use public ffmpeg image to get the binaries
FROM --platform=linux/amd64 jrottenberg/ffmpeg:4.4-ubuntu2004 as ffmpeg

# Stage 2: Final Lambda image
FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:18

# Copy ffmpeg binaries from the ffmpeg image
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/

# Install system dependencies for Chrome/Puppeteer
RUN yum update -y && \
    yum install -y \
    alsa-lib.x86_64 \
    atk.x86_64 \
    cups-libs.x86_64 \
    gtk3.x86_64 \
    ipa-gothic-fonts \
    libXcomposite.x86_64 \
    libXcursor.x86_64 \
    libXdamage.x86_64 \
    libXext.x86_64 \
    libXi.x86_64 \
    libXrandr.x86_64 \
    libXScrnSaver.x86_64 \
    libXtst.x86_64 \
    pango.x86_64 \
    xorg-x11-fonts-100dpi \
    xorg-x11-fonts-75dpi \
    xorg-x11-fonts-cyrillic \
    xorg-x11-fonts-misc \
    xorg-x11-fonts-Type1 \
    xorg-x11-utils \
    nss.x86_64 \
    && yum clean all \
    && rm -rf /var/cache/yum

# Set working directory
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy function code
COPY index.js ./

# Set environment variables
ENV AWS_EXECUTION_ENV=AWS_Lambda_nodejs18.x
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH="/var/task/node_modules/@sparticuz/chromium/bin"

# Lambda specific settings
ENTRYPOINT [ "/lambda-entrypoint.sh" ]
CMD [ "index.handler" ]
