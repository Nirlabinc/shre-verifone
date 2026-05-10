FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY apps ./apps
COPY services ./services
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY apps/dashboard-ui ./apps/dashboard-ui
COPY apps/product-landing ./apps/product-landing
COPY apps/access-portal ./apps/access-portal
