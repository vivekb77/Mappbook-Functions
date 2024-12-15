# Simplified Dockerfile focusing on essential dependencies
FROM public.ecr.aws/lambda/nodejs:18

# Install only the absolutely necessary Chrome dependencies
RUN yum install -y \
    pango.x86_64 \
    libXcomposite.x86_64 \
    libXcursor.x86_64 \
    libXdamage.x86_64 \
    libXext.x86_64 \
    libXi.x86_64 \
    libXtst.x86_64 \
    cups-libs.x86_64 \
    libXScrnSaver.x86_64 \
    libXrandr.x86_64 \
    alsa-lib.x86_64 \
    atk.x86_64 \
    gtk3.x86_64 \
    nss.x86_64 \
    && yum clean all \
    && rm -rf /var/cache/yum

# No need to create persistent directories
WORKDIR ${LAMBDA_TASK_ROOT}

COPY package*.json ./
RUN npm ci --only=production

COPY index.js ./

# Minimal environment configuration
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV AWS_LAMBDA_FUNCTION_MEMORY_SIZE=2048

CMD [ "index.handler" ]