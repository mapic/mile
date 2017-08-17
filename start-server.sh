#!/bin/bash

# ensure log folder
mkdir -p /mapic/mile/log

# yarn
yarn config set cache-folder /mapic/mile/.yarn
yarn install

# go to folder
cd /mapic/mile

# spin server
forever -f -v -w --watchDirectory src/ src/mile.js
