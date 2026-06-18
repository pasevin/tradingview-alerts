import os

app = os.environ.get('APP_PATH', 'TradingView Alerts.app')
volume_name = 'TradingView Alerts'
format = 'UDBZ'

# Files to include
files = [app]

# Symlink to /Applications
symlinks = {'Applications': '/Applications'}

# Background image — dmgbuild handles copying it into .background/ automatically
background = os.environ.get('BG_PATH', 'dmg-background.png')

# Icon positions — coordinates are (x, y) from bottom-left of content area
# Arrow is at center x=270 (midpoint of 120 and 420)
# Icons at y=120 (vertically centered around the arrow)
icon_locations = {
    'TradingView Alerts.app': (120, 120),
    'Applications': (420, 120),
}

# Window — 540x360 content area
window_rect = ((200, 120), (540, 360))
default_view = 'icon-view'
show_icon_preview = True
icon_size = 96
text_size = 14

# Hide extensions and hidden files
show_ext = False
show_hidden = False

# Sign the DMG if identity available
sign_identity = os.environ.get('APPLE_SIGNING_IDENTITY', '')
