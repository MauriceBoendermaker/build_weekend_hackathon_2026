# Build stage: install all dependencies and compile TypeScript.
FROM apify/actor-node:22 AS builder

COPY package*.json ./

RUN npm install --include=dev --audit=false --fund=false

COPY . ./

RUN npm run build

# Runtime stage: production dependencies plus the compiled output only.
FROM apify/actor-node:22

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false --fund=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --from=builder /usr/src/app/dist ./dist
COPY . ./

CMD ["npm", "run", "start:prod", "--silent"]
