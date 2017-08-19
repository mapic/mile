#!/bin/bash
git remote set-url origin https://github.com/mapic/mile.git
git pull origin master
git checkout ${MAPIC_MILE_BRANCH:-master}
git remote set-url origin git@github.com:mapic/mile.git
