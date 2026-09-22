#!/bin/zsh

UPDATE_FILES=(
  'VERSION'
)

CURRENT_BRANCH=$(git branch --show-current)
case "$CURRENT_BRANCH" in
  "develop")
    echo "Processing bump version in develop"
    ;;
  "test")
    echo "Processing bump version in test"
    ;;
  "uat")
    echo "Processing bump version in uat"
    ;;
  "master")
    echo "Processing bump version in master"
    ;;
  *)
    echo "You are on feature branch. Please checkout to develop | test | uat | master to continue!"
    exit 1
    ;;
esac

if [ -f VERSION ]; then
  BASE_STRING=$(cat VERSION)
  BASE_LIST=($(echo "$BASE_STRING" | tr '.' ' '))
  V_MAJOR=${BASE_LIST[0]}
  V_MINOR=${BASE_LIST[1]}
  V_PATCH=${BASE_LIST[2]}
  V_PATCH=$((V_PATCH + 1))
  echo "Current version: $BASE_STRING"
  SUGGESTED_VERSION="$V_MAJOR.$V_MINOR.$V_PATCH"
  echo -n "Enter new version number (press Enter to apply suggested version [$SUGGESTED_VERSION]): "
  read -r INPUT_STRING
  echo "$INPUT_STRING"
  if [ "$INPUT_STRING" = "" ]; then
    INPUT_STRING=$SUGGESTED_VERSION
  fi
  echo "Will set new version to $INPUT_STRING"
  for file in "${UPDATE_FILES[@]}"; do
    sed -i -e "s/$BASE_STRING/$INPUT_STRING/" "$file"
    git add "$file"
  done
  ###### git commit file changes #########
  git add "${UPDATE_FILES[@]}"
  git commit -m "Bumped version to ${INPUT_STRING}"
  ###### git push #########
  git push origin "$CURRENT_BRANCH"
  ###### git tag ###########
  git tag "$INPUT_STRING"
  git push origin "$INPUT_STRING"
  ###### remove backup files ###########
  for file in "${UPDATE_FILES[@]}"; do
    rm -rf "${file}-e"
  done
else
  echo "Could not find a VERSION file."
fi

echo "Finished!"
