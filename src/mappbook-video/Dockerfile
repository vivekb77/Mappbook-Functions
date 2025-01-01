FROM public.ecr.aws/lambda/nodejs:18

# First update and install dependencies
RUN yum update -y && \
    yum install -y xz tar findutils

# Download and install static FFmpeg build
RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o ffmpeg.tar.xz && \
    tar Jxf ffmpeg.tar.xz && \
    find . -name ffmpeg -type f -exec mv {} /usr/local/bin/ffmpeg \; && \
    find . -name ffprobe -type f -exec mv {} /usr/local/bin/ffprobe \; && \
    chmod +x /usr/local/bin/ffmpeg && \
    chmod +x /usr/local/bin/ffprobe && \
    rm -f ffmpeg.tar.xz && \
    rm -rf ffmpeg-*

# Install only the necessary Chrome dependencies
RUN yum install -y \
    pango \
    libX11 \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXtst \
    cups-libs \
    libXrandr \
    alsa-lib \
    atk \
    gtk3 \
    nss \
    && yum clean all \
    && rm -rf /var/cache/yum

WORKDIR ${LAMBDA_TASK_ROOT}

# Copy application files
COPY package*.json ./
RUN npm ci --only=production
COPY index.js ./

# Environment configuration
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV AWS_LAMBDA_FUNCTION_MEMORY_SIZE=2048
ENV PATH="/usr/local/bin:${PATH}"

# Verify installations
RUN ffmpeg -version && \
    echo "FFmpeg installed successfully"

CMD [ "index.handler" ]