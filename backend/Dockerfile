FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S growapp && adduser -S growapp -G growapp
COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
COPY database ./database
RUN chown -R growapp:growapp /app
USER growapp
EXPOSE 8080
CMD ["node", "src/server.js"]
