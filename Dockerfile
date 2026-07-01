# Stage 1: Build the React application
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Serve the static files using Nginx
FROM nginx:alpine
# Copy the built files to Nginx's default public directory
COPY --from=build /app/dist /usr/share/nginx/html
# Copy a custom Nginx configuration template to support Cloud Run PORT injection
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
