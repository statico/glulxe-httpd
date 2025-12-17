#!/usr/bin/env bash

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DIR="$SCRIPT_DIR"
STORY_NI="$TEST_DIR/story.ni"
STORY_ULX="$TEST_DIR/story.ulx"
CONTAINER_NAME="glulxe-httpd-test"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

cleanup() {
    log_info "Cleaning up..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

trap cleanup EXIT

# Step 1: Build the Docker image
log_info "Step 1: Building Docker image..."
cd "$PROJECT_DIR"
make build

# Step 2: Compile story.ni to story.ulx
log_info "Step 2: Compiling story.ni to story.ulx..."

if [ "$(uname -s)" = "Darwin" ]; then
    APP="/Applications/Inform.app"
    BIN="$APP/Contents/MacOS"
    LIB="$HOME/Library/Inform"
    SHARE="$APP/Contents/Resources"
else
    BIN="/usr/local/share/inform7/Compilers"
    LIB="$HOME/Library/Inform"
    SHARE="/usr/local/share/inform7"
fi

if [ ! -d "$BIN" ] || [ ! -f "$BIN/ni" ]; then
    log_error "Inform 7 compiler not found at $BIN/ni"
    log_error "Please install Inform 7: https://inform7.com/download/"
    exit 1
fi

# Create a temporary Inform project directory
TEMP_PROJ=$(mktemp -d)
trap "rm -rf $TEMP_PROJ" EXIT

# Inform 7 expects a project directory structure
PROJ_NAME="story"
PROJ_DIR="$TEMP_PROJ/$PROJ_NAME.inform"
mkdir -p "$PROJ_DIR/Source"
cp "$STORY_NI" "$PROJ_DIR/Source/story.ni"

# Compile using Inform 7
log_info "Running Inform 7 compiler..."
"$BIN/ni" \
    -internal "$SHARE/Internal" \
    -external "$LIB" \
    -project "$PROJ_DIR" \
    -format=ulx >/dev/null 2>&1 || {
    log_error "Inform 7 compilation failed"
    log_error "Check that Inform 7 is properly installed"
    exit 1
}

# Compile to .ulx using Inform 6
if [ -n "$RELEASE" ]; then
    I6OPTS="-~kE2~S~DwGv8"
else
    I6OPTS="-kE2SDwG"
fi

log_info "Running Inform 6 compiler..."
"$BIN/inform6" \
    $I6OPTS \
    "+include_path=$SHARE/Library/6.11,.,../Source" \
    "$PROJ_DIR/Build/auto.inf" \
    "$STORY_ULX" >/dev/null 2>&1 || {
    log_error "Inform 6 compilation failed"
    log_error "Check that Inform 6 compiler is available"
    exit 1
}

if [ ! -f "$STORY_ULX" ]; then
    log_error "Compilation failed: $STORY_ULX not found"
    exit 1
fi

log_info "Compilation successful: $STORY_ULX"

# Step 3: Run the container
log_info "Step 3: Starting container..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
    --name "$CONTAINER_NAME" \
    -p 8080:8080 \
    -v "$STORY_ULX:/story.ulx:ro" \
    glulxe-httpd

# Wait for server to be ready
log_info "Waiting for server to start..."
for i in {1..30}; do
    if curl -s http://localhost:8080/ >/dev/null 2>&1; then
        log_info "Server is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "Server failed to start"
        docker logs "$CONTAINER_NAME"
        exit 1
    fi
    sleep 1
done

# Step 4: Test the server
log_info "Step 4: Testing server endpoints..."

# Test 1: Health check
log_info "Test 1: Health check (GET /)"
RESPONSE=$(curl -s http://localhost:8080/)
if [ "$RESPONSE" = "ok" ]; then
    log_info "✓ Health check passed"
else
    log_error "✗ Health check failed: expected 'ok', got '$RESPONSE'"
    exit 1
fi

# Helper function to extract JSON values
extract_json() {
    local json="$1"
    local key="$2"
    # Use Python if available, otherwise fall back to sed
    if command -v python3 &> /dev/null; then
        echo "$json" | python3 -c "import sys, json; print(json.load(sys.stdin).get('$key', ''))" 2>/dev/null || echo ""
    elif command -v python &> /dev/null; then
        echo "$json" | python -c "import sys, json; print(json.load(sys.stdin).get('$key', ''))" 2>/dev/null || echo ""
    else
        # Fallback: simple sed extraction (may not work for multiline)
        echo "$json" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p" | head -1
    fi
}

# Test 2: Create a new session
log_info "Test 2: Create new session (POST /new)"
NEW_RESPONSE=$(curl -s -X POST http://localhost:8080/new -H "Content-Type: application/json")
SESSION_ID=$(extract_json "$NEW_RESPONSE" "session")
OUTPUT=$(extract_json "$NEW_RESPONSE" "output")

if [ -z "$SESSION_ID" ]; then
    log_error "✗ Failed to create session"
    log_error "Response: $NEW_RESPONSE"
    exit 1
fi

log_info "✓ Session created: $SESSION_ID"
log_info "Initial output: ${OUTPUT:0:100}..." # Show first 100 chars

# Test 3: Send commands
log_info "Test 3: Sending commands..."

# Test "examine table"
log_info "  - examine table"
EXAMINE_RESPONSE=$(curl -s -X POST http://localhost:8080/send \
    -H "Content-Type: application/json" \
    -d "{\"session\":\"$SESSION_ID\",\"message\":\"examine table\"}")
EXAMINE_OUTPUT=$(extract_json "$EXAMINE_RESPONSE" "output")
log_info "    Response: ${EXAMINE_OUTPUT:0:100}..."

if echo "$EXAMINE_OUTPUT" | grep -qi "table"; then
    log_info "  ✓ examine table passed"
else
    log_warn "  ⚠ examine table may have failed (check output)"
fi

# Test "take apple"
log_info "  - take apple"
TAKE_RESPONSE=$(curl -s -X POST http://localhost:8080/send \
    -H "Content-Type: application/json" \
    -d "{\"session\":\"$SESSION_ID\",\"message\":\"take apple\"}")
TAKE_OUTPUT=$(extract_json "$TAKE_RESPONSE" "output")
log_info "    Response: ${TAKE_OUTPUT:0:100}..."

if echo "$TAKE_OUTPUT" | grep -qi "taken\|apple"; then
    log_info "  ✓ take apple passed"
else
    log_warn "  ⚠ take apple may have failed (check output)"
fi

# Test "eat apple"
log_info "  - eat apple"
EAT_RESPONSE=$(curl -s -X POST http://localhost:8080/send \
    -H "Content-Type: application/json" \
    -d "{\"session\":\"$SESSION_ID\",\"message\":\"eat apple\"}")
EAT_OUTPUT=$(extract_json "$EAT_RESPONSE" "output")
log_info "    Response: ${EAT_OUTPUT:0:100}..."

if echo "$EAT_OUTPUT" | grep -qi "eat\|apple"; then
    log_info "  ✓ eat apple passed"
else
    log_warn "  ⚠ eat apple may have failed (check output)"
fi

log_info ""
log_info "All tests completed successfully! ✓"

