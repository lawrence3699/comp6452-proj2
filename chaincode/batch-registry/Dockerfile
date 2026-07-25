FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY dist ./dist
EXPOSE 9999
# Shell form required — $CHAINCODE_ID must expand at container start, not build time.
CMD sh -c "npx fabric-chaincode-node server --chaincode-address=0.0.0.0:9999 --chaincode-id=$CHAINCODE_ID"
