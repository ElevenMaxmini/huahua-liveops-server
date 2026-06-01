FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

CMD ["npm", "start"]

