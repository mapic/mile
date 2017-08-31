#!/bin/bash
BRANCH=${MAPIC_MILE_BRANCH:-master}
echo "Checking out $BRANCH"
git remote set-url origin https://github.com/mapic/mile.git
git pull origin master
git checkout $BRANCH
git remote set-url origin git@github.com:mapic/mile.git
