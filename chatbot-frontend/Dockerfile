FROM nginx:1.28.0-alpine3.21-slim

# Copy the build output to replace the default nginx contents.
COPY ./dist/chatbot-frontend /usr/share/nginx/html
COPY ./nginx.conf /etc/nginx/nginx.conf

# Expose port 80
EXPOSE 80