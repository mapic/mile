#!/bin/bash

# add key
# touch ~/.ssh/known_hosts
# ssh-keyscan -t rsa github.com >> ~/.ssh/known_hosts
echo "PWD1: $PWD"
cd /mapic/mile
echo "PWD2: $PWD"
git remote set-url origin https://github.com/mapic/mile.git
git pull origin master
git checkout ${MAPIC_MILE_BRANCH:-master}
git remote set-url origin git@github.com:mapic/mile.git
