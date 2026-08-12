FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=4010

EXPOSE 4010

CMD ["npm", "start"]
