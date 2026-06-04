FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3333
ENV PORT=3333
CMD ["node", "server.js"]
