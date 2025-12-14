# Gunakan Node.js image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Expose port (Hugging Face menggunakan port 7860)
EXPOSE 7860

# Set environment variable
ENV PORT=7860
ENV NODE_ENV=production

# Start server
CMD ["node", "index.js"]
