FROM node:22-alpine
WORKDIR /app
COPY --chown=1000:1000 package.json ./
RUN npm install --production
COPY --chown=1000:1000 . .
EXPOSE 3000
# Kubernetes runs app Pods with runAsNonRoot and no runAsUser, so the image
# must name a numeric non-root user or the Pod is refused before it starts.
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
