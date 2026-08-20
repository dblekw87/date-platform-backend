FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# The server alone is not the whole program. Migrations and the backfill and
# check scripts are part of running this, and an image without them can start
# but cannot be set up or inspected.
COPY src ./src
COPY db ./db
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=4010

EXPOSE 4010

CMD ["npm", "start"]
