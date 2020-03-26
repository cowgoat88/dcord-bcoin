from dotenv import load_dotenv
import os

load_dotenv()

DISCORD_CLIENT = os.getenv('DISCORD_CLIENT')
DISCORD_GUILD = os.getenv('DISCORD_GUILD')
DISCORD_CHANNEL = os.getenv('DISCORD_CHANNEL')
WORLDCOIN = os.getenv('WORLDCOIN')
