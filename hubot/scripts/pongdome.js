'use strict';

const Table = require('cli-table2');
const EventEmitter = require('events').EventEmitter;
const uuid = require('node-uuid');
const numeral = require('numeral');
const util = require('util');
const WebSocketServer = require('ws').Server;

const port = process.env.PORT || 3030;

class Socket {
  constructor(ws) {
    this._ws = ws;
    this._ws.on('message', this._onMessage.bind(this));
  }

  _onMessage(data) {
    data = JSON.parse(data);
    this.emit(data.event, data.data);
  }

  send(event, data) {
    this._ws.send(JSON.stringify({ event, data }));
  }
}

util.inherits(Socket, EventEmitter);

function getThreadID(res) {
  return res.message.metadata.thread_id || uuid.v4();
}

function getName(text) {
  const match = text.match(/@[a-z0-9]+/i);
  if (!match) return;
  return match[0].substr(1);
}

module.exports = robot => {
  const wss = new WebSocketServer({ port });
  let socket;

  const challenges = {};
  const threads = {};

  function findRequest(res) {
    const challengee = res.message.user;
    const requests = challenges[challengee.name.toLowerCase()] || [];

    if (!requests.length) {
      return res.send('Could not find a challenge to accept.');
    }

    const challenger_name = getName(res.message.text);
    const chat_thread_id = res.message.metadata.thread_id;
    let request;

    if (!challenger_name) {
      if (chat_thread_id) {
        request = threads[chat_thread_id];
      } else if (requests.length > 1) {
        res.send('Multiple possible challenges, please mention your partner.');
        return;
      } else {
        request = requests.pop();
      }
    } else {
      request = requests.find(r => r.challenger.name.toLowerCase() === challenger_name.toLowerCase());
    }

    if (!request) {
      res.send('Could not find a challenge to accept.');
      return;
    }

    if (request.challengee.name.toLowerCase() !== challengee.name.toLowerCase()) {
      res.send('This is not your challenge!');
      return;
    }

    return request;
  }

  function addRequest(request) {
    const name = request.challengee.name.toLowerCase();
    challenges[name] = challenges[name] || [];
    challenges[name].push(request);
    threads[request.thread_id] = request;
  }

  function removeRequest(request) {
    const name = request.challengee.name.toLowerCase();
    challenges[name] = challenges[name].filter(r => r.thread_id !== request.thread_id);
    delete threads[request.thread_id];
  }

  wss.on('connection', ws => {
    if (socket) {
      socket._ws.terminate();
    }

    socket = new Socket(ws);
    socket._ws.on('error', err => robot.logger.error(err));

    socket.on('match', data => {
      const request = threads[data.thread_id];
      request.res.send(`@${request.challenger.name} @${request.challengee.name} Game on!`);
    });

    socket.on('queue', data => {
      const request = threads[data.thread_id];
      request.res.send(`@${request.challenger.name} @${request.challengee.name} Queued Up! You're ${numeral(data.position).format('0o')} in the queue.`);
    });

    socket.on('end', data => {
      const request = threads[data.thread_id];
      const winner_total = data.winner.points.reduce((a, b) => a + b, 0);
      const loser_total = data.loser.points.reduce((a, b) => a + b, 0);
      request.res.send(`${data.winner.name} beat ${data.loser.name}! ${winner_total} points to ${loser_total} points.`);
      removeRequest(request);
    });

    socket.on('leaderboard', data => {
      const request = threads[data.thread_id];

      const table = new Table({
        head: ['#', 'name', 'elo', 'wins', 'losses', 'ratio', 'streak'],
        style: { head: [], border: [] }
      });

      data.leaderboard.forEach((player, rank) => {
        table.push([rank + 1, player.name, player.elo, player.wins, player.losses, player.ratio, player.streak]);
      })

      request.res.send('\n```\n' + table.toString() + '\n```');
    });
  });

  robot.hear(/#challenge/, res => {
    const challenger = res.message.user;
    const challengee_name = getName(res.message.text);

    if (!challengee_name) {
      return res.send('Could not find who to challenge.');
    }

    const challengee = { name: challengee_name };
    const requests = challenges[challengee.name.toLowerCase()] || [];
    const thread_id = getThreadID(res);

    if (threads[thread_id]) {
      return res.send('There\'s already a challenge here.');
    }

    addRequest({
      res,
      challenger,
      challengee,
      thread_id
    });
  });

  robot.hear(/#accept/, res => {
    const request = findRequest(res);
    if (!request) return;

    request.challengee = res.message.user;
    request.accepted = true;

    socket.send('match', {
      thread_id: request.thread_id,
      player_one: { name: request.challenger.name, id: request.challenger.id },
      player_two: { name: request.challengee.name, id: request.challengee.id }
    });
  });

  robot.hear(/#cancel/, res => {
    const request = findRequest(res);
    if (!request) return;

    if (request.accepted) {
      socket.send('cancel', { thread_id: request.thread_id });
    }

    request.res.send('Game cancelled.');
    removeRequest(request);
  });

  robot.hear(/#leaderboard/, res => {
    const thread_id = getThreadID(res);
    threads[thread_id] = { res };
    socket.send('leaderboard', { thread_id });
  });
}