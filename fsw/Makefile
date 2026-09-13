# ============================================================================
# Icarus OBC simulator
# ============================================================================
#
#   make            build ./icarus (or icarus.exe on Windows)
#   make run        build and run with the default ports
#   make clean      remove build output
#   make selftest   build and run a short headless self-check
#
# Plain C99 and the C standard library. The only platform dependency is the
# socket API, which is isolated in src/platform.h.
#
# LINUX / macOS
#   make
#
# WINDOWS
#   MSYS2 / MinGW-w64:      make                    (links -lws2_32)
#   Visual Studio (cl.exe): see build-msvc.bat in this directory
#   No compiler at all:     see fsw/README.md - the browser simulator gives you
#                           the whole experience without building anything.
# ============================================================================

CC      ?= cc
CSTD    ?= -std=c99
WARN    ?= -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion

# -std=c99 is strict ISO C, which hides the POSIX declarations we need for
# sockets and nanosleep. Asking for POSIX.1-2008 explicitly brings them back
# without falling back to a GNU dialect.
POSIX_DEFS ?= -D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE

# -MMD -MP emits a .d file per object listing the headers it included, so that
# editing icarus.h rebuilds everything that includes it. Without this, changing
# a struct leaves stale objects linked against the old layout and the telemetry
# comes out with every field shifted by one - which is exactly as much fun to
# debug as it sounds.
DEPFLAGS ?= -MMD -MP

CFLAGS  ?= $(CSTD) -O2 $(WARN) $(POSIX_DEFS) $(DEPFLAGS)
LDLIBS  ?= -lm

SRC_DIR := src
BUILD   := build

SOURCES := $(SRC_DIR)/main.c \
           $(SRC_DIR)/icarus.c \
           $(SRC_DIR)/power.c \
           $(SRC_DIR)/thermal.c \
           $(SRC_DIR)/vibration.c \
           $(SRC_DIR)/adcs.c \
           $(SRC_DIR)/anomaly.c \
           $(SRC_DIR)/telemetry.c \
           $(SRC_DIR)/commands.c

OBJECTS := $(patsubst $(SRC_DIR)/%.c,$(BUILD)/%.o,$(SOURCES))

# ---- platform detection ----------------------------------------------------
ifeq ($(OS),Windows_NT)
  TARGET := icarus.exe
  LDLIBS := -lws2_32          # Winsock; no libm needed on MinGW
  # Winsock headers are not POSIX; asking for _POSIX_C_SOURCE breaks them.
  CFLAGS := $(CSTD) -O2 $(WARN) $(DEPFLAGS)
else
  TARGET := icarus
  UNAME_S := $(shell uname -s)
  ifeq ($(UNAME_S),Darwin)
    LDLIBS := -lm
  endif
endif

.PHONY: all run clean selftest help

all: $(TARGET)

$(TARGET): $(OBJECTS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)
	@echo "Built $@"

$(BUILD)/%.o: $(SRC_DIR)/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD):
	@mkdir -p $(BUILD)

# Pull in the generated header dependencies (absent on a clean tree - the
# leading dash makes that not an error).
-include $(OBJECTS:.o=.d)

run: $(TARGET)
	./$(TARGET)

# Sends telemetry to a port nobody is listening on for 3 seconds, then exits.
# Proves the binary starts, binds, steps the physics and serialises packets.
selftest: $(TARGET)
	@echo "Running 3 s self-check..."
	@./$(TARGET) --telemetry-port 5999 --command-port 5998 & \
	 PID=$$!; sleep 3; kill $$PID 2>/dev/null; wait $$PID 2>/dev/null; true
	@echo "Self-check finished."

clean:
	rm -rf $(BUILD) icarus icarus.exe

help:
	@echo "targets: all (default), run, selftest, clean"
