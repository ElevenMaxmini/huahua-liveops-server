FROM node:20-alpine

WORKDIR /opt/application

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY run.sh ./run.sh
RUN chmod +x ./run.sh

RUN mkdir -p /opt/application/data

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

CMD ["/opt/application/run.sh"]

