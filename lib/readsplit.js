// Copyright 2016 Luca-SAS, licensed under the Apache License 2.0

var fs = require('fs');
//var Lines = require('../lib/lines.js');

/**
  * Compute N-Length logic split of given file
  */
function splitLocalFile(file, N, callback) {
  var split = [];
  var size = fs.statSync(file).size;
  var maxBlockSize = Math.ceil(size / (N || 1));      // taille max d'un block (minimum de 1 byte dans un block)
  var start = 0;

  // var str = fs.readFileSync(file, {encoding: 'utf8'}).replace(/\n/g, '*');
  // console.log(str)
  while (start < size) {
    // console.log('Split n° %d = %s', split.length, str.substr(start, maxBlockSize + 1))
    split.push({index: split.length, chunk: [{path: file, opt: {start: start, end: start + maxBlockSize}}]});
    start += maxBlockSize + 1;
  }

  callback(split);
}

function splitDistributedFile(file, N, callback) {  // emulates a distributed file for now
  callback([
    {
      index: 0, chunk: [
        {path: './test.dat', opt: {start: 0, end: 9}},
        {path: './test.dat', opt: {start: 10, end: 19}
      }]
    }, {
      index: 1,
      chunk: [
        {path: './test.dat', opt: {start: 20, end: 29}},
        {path: './test.dat', opt: {start: 30}
      }]
    }
  ]);
}

function getFirstLine(split, chunk_buffer, s, getStream, done) {
  // console.log('Split n° ' + (s - 1) + ' seeks end of line starting with : ' + chunk_buffer.replace(/\n/g, '*'))
  var p = 0, firstLineFound = false, firstLine;
  var isLastSplit = (split[s].index == (split.length - 1));

  function readPart(part, partDone) {
    var isLastPart = (p == split[s].chunk.length - 1);
    //var rs = fs.createReadStream(part.path, part.opt);
    var rs = getStream(part, part.opt);

    function processChunk(chunk) {
      var lines = (chunk_buffer + chunk).split(/\r\n|\r|\n/);
      chunk_buffer = lines.pop();
      if (lines.length > 0) {
        firstLine = lines[0];
        firstLineFound = true;
        //rs.destroy();
      } else rs.once('data', processChunk);
    }

    rs.once('data', processChunk);

    rs.on('end', function () {
      if (firstLineFound) done(firstLine);
      else if (!isLastPart) partDone();
      else if (isLastSplit) done(chunk_buffer);
      else {
        getFirstLine(split, chunk_buffer, s + 1, getStream, done);
      }
    });
  }

  function end() {
    if (++p < split[s].chunk.length) readPart(split[s].chunk[p], end);
  }

  readPart(split[s].chunk[p], end);
}

function readSplit(split, s, processLine, splitDone, getStream) {
  if (split.length == 0) return splitDone();
  var isFirstSplit = (split[s].index == 0);
  var isLastSplit = (split[s].index == (split.length - 1));
  var chunk_buffer = '', p = 0;
  var hasToSkipFirstLine = isFirstSplit ? false : undefined;  // si firstSplit on sait déjà que l'on ne doit pas ignorer la première ligne
  var firstLineFound = isFirstSplit ? true : false;

  function readPart(part, partDone) {
    var isFirstPart = (p == 0);
    var isLastPart = (p == split[s].chunk.length - 1);
    var chunkLastChar = '';
    // Si le split en cours de traitement n'est pas le premier, il faut déterminer si on doit sauter la première ligne ou non
    // Pour ce faire on lit un octet avant le début de la première partie du split et on regarde si le caractère est un EOL
    var opt = (!isFirstSplit && isFirstPart) ? {start: part.opt.start - 1, end: part.opt.end} : part.opt;
    //var rs = fs.createReadStream(part.path, opt);
    var rs = getStream(part, opt);

    function processChunkOnce(chunk) {                      // Executé tant que la première ligne n'est pas complète
      // console.log('Split n° %d found chunk = %s', s, String(chunk).replace(/\n/g, '*'))
      if (hasToSkipFirstLine == undefined) {                  // Si on ne sait pas encore si on doit ignorer la première ligne
        chunk = String(chunk);                        // Test du premier caractère (ie. dernier caractère du split précédent)
        hasToSkipFirstLine = (chunk.charAt(0) != '\n');           // si différent de EOL on doit ignorer la première ligne
        // console.log('Has to skip first line = ' + hasToSkipFirstLine)
        chunk = chunk.substr(1);                      // On jette le premier caractère
        // console.log('Chunk after first byte test = ' + chunk)
        if (!hasToSkipFirstLine) firstLineFound = true;
      }
      var str = (chunk_buffer + chunk);
      chunkLastChar = str.charAt(str.length - 1);               // store last character ici le last character est peut-etre le dernier de la premiere ligne
      var lines = str.split(/\r\n|\r|\n/);                  // break du buffer en tableau de lignes
      chunk_buffer = lines.pop();                       // extraction de la dernière ligne incomplète
      if (lines.length) {                           // si plus d'une ligne
        firstLineFound = true;                        // alors on vient de trouver la première ligne
        var start = hasToSkipFirstLine ? 1 : 0;               // si on doit ignorer la première ligne, on commence une ligne plus loin
        for (var i = start; i < lines.length; i++) processLine(lines[i]); // on process les lignes à partir du bon point de départ
        if (lines.length == 1) chunkLastChar = '';
        rs.on('data', processChunk);                    // on passe alors en régime établi
        // console.log('Found first line')
      } else rs.once('data', processChunkOnce);               // sinon il faut lire un peu plus d'octet pour compléter la première ligne
    }

    var processChunk = function(chunk) {                    // Process chunk en régime établi
      var str = chunk_buffer + chunk;
      chunkLastChar = str.charAt(str.length - 1);               // store last character
      var lines = str.split(/\r\n|\r|\n/);
      chunk_buffer = lines.pop();
      for (var i = 0; i < lines.length; ++i) processLine(lines[i]);
    };

    rs.on('end', function () {
      // console.log(chunk_buffer)
      if (!isLastPart) return partDone();                   // il reste des parties à lire on termine la part
      if (isLastSplit) {                            // si dernière partie du dernier split
        if (!firstLineFound) {
          firstLineFound = true;
          if (!hasToSkipFirstLine) processLine(chunk_buffer);       // on process la dernière ligne
        } else processLine(chunk_buffer);                 // on process la dernière ligne
        splitDone();                            // on termine le split
      } else {                                // sinon ce n'est pas le dernier split mais c'est la derniere part
        if (!firstLineFound) {                        // si la première ligne n'a pas encore été trouvée
          if (chunkLastChar == '\n') {                  // si le dernier caractère est un EOL
            firstLineFound = true;                    // on a trouvé la première ligne
            if (!hasToSkipFirstLine) processLine(chunk_buffer);     // on la process s'il le faut
          }                               // sinon il y a moins d'une ligne dans le split, rien à processer
          splitDone();                          // on termine le split
        } else {                              // SINON la première ligne avait déjà été trouvée
          if (chunkLastChar == '\n') {                  // si le dernier caractère est un EOL
            processLine(chunk_buffer);
            splitDone();
          } else {                            // sinon la dernière ligne n'est pas complète
            // console.log('HELLO')
            if (chunk_buffer == '') {
              splitDone();
            } else {
              getFirstLine(split, chunk_buffer, s + 1, getStream, function(firstline) {   // On termine la lecture de la ligne sur les splits suivant
                processLine(firstline);         // on process la ligne
                splitDone();                      // on termine
              });
            }
          }
        }
      }
    });

    rs.once('data', processChunkOnce);
  }

  function end() {
    if (++p < split[s].chunk.length)
      readPart(split[s].chunk[p], end);
  }

  readPart(split[s].chunk[p], end);
}

module.exports.splitLocalFile = splitLocalFile;
module.exports.splitDistributedFile = splitDistributedFile;
module.exports.readSplit = readSplit;
