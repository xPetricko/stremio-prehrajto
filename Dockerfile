FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package*.json ./

RUN npm install --omit=dev

COPY --chown=node:node . .

ENV PORT=7000

EXPOSE 7000

USER node

CMD ["node", "index.js"]
