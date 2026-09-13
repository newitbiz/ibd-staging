FROM nginx:alpine

# Railway injects PORT; default to 8080 for local runs.
ENV PORT=8080

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

# Rewrite listen port from template placeholder at start.
CMD ["/bin/sh", "-c", "sed -i \"s/LISTEN_PORT/${PORT}/g\" /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
