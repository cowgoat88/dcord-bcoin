# python3 intervalbot.py

import discord
import asyncio
import random
from btcinfo import avg_price
from datetime import datetime
from settings import (
    DISCORD_CLIENT,
    DISCORD_GUILD,
    DISCORD_CHANNEL
    )
# secret bot token
TOKEN = DISCORD_CLIENT
# time interval
INTERVAL = 360
# the message is sent to a channel specified with an ID below
CHANNEL = int(DISCORD_GUILD)
# message to be sent
MESSAGE = '$$$'

client = discord.Client()

@client.event
async def on_ready():
    print(client.user.name)
    print(client.user.id)
    game = discord.Game("with the BTC")
    await client.change_presence(status=discord.Status.idle, activity=game)

async def btc_status():
    await client.wait_until_ready()
    channel=client.get_channel(int(DISCORD_CHANNEL))
    while not client.is_closed():
        try:
            message = 'BTC/USD: '+ avg_price()
            #message=datetime.strftime(datetime.now(),'%H:%M')
            await channel.send(message)
            await asyncio.sleep(INTERVAL)
        except Exception as e:
            print(e)
            await asyncio.sleep(INTERVAL)

@client.event
async def on_message(message):
    if message.author == client.user:
        print('ignore msg from client.user: ', client.user)
        return

    client_word = '$btc'
    if message.content.startswith(client_word):
        text = 'As requested by master {}\nBTC/USD: '.format(message.author)+ avg_price()
        if not text:
            text = "woops something went wrong"

        await message.channel.send(text)

client.loop.create_task(btc_status())
client.run(TOKEN)
