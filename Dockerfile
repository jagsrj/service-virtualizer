FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY profiles ./profiles
COPY stubs ./stubs
COPY timelines ./timelines
ENV PORT=4100
EXPOSE 4100
USER node
CMD ["node", "src/index.js"]
