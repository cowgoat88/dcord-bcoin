import requests
import json
from math import ceil
from settings import (
    WORLDCOIN
)
tickers = [
    ('coindesk','https://api.coindesk.com/v1/bpi/currentprice.json'),
    ('blockchain','https://blockchain.info/ticker'),
    ('worldcoin', ' https://www.worldcoinindex.com/apiservice/v2getmarkets?key={}&fiat=usd'.format(WORLDCOIN)),
    ('coinbase', 'https://api.coinbase.com/v2/prices/spot?currency=USD')
    ]

def get_current_price(exchange,url):
    r = requests.get(url)
    rawj = json.loads(r.text)

    if exchange == 'coindesk':
        btc_rate = rawj['bpi']['USD']['rate_float']
    elif exchange == 'blockchain':
        btc_rate = rawj['USD']['last']
    elif exchange == 'worldcoin':
        for tick in rawj['Markets'][0]:
            if tick['Label'] == 'BTC/USD':
                btc_rate = tick['Price']
    elif exchange == 'coinbase':
        btc_rate = rawj['data']['amount']

    return((ceil(float(btc_rate)),exchange))

def avg_price():
    lst = [get_current_price(t[0],t[1]) for t in tickers]
    print(lst)
    avg = 0
    for p in lst:
        avg += p[0]
    avg_price = avg/len(lst)
    print(avg_price)
    return(str(avg_price))
