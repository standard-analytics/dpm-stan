var path = require('path')
  , assert = require('assert')
  , rimraf = require('rimraf')
  , fs = require('fs')
  , Ldpm = require('..');


var root = path.dirname(__filename);

describe('pubmed', function(){

  this.timeout(320000);

  var conf = {
    protocol: 'http',
    port: 3000,
    hostname: 'localhost',
    strictSSL: false,
    sha:true,
    name: "user_a",
    email: "user@domain.com",
    password: "user_a"
  };

  it('should return a pkg with name plosone-haseleu-2014 when asked for finger-wrinkles paper through doi', function(done){
    var ldpm = new Ldpm(conf,path.join(root,'__tests'));
    fs.mkdir('__tests', function(err){
      if(err) console.log(err);
      ldpm.convert('PMC3885627', function(err,pkg){
        assert.equal(pkg.name,'plos-one-haseleu-2013');
        rimraf('__tests',function(err){
          if(err) console.log(err);
          done();
        });
      });
    });
  });

  it('should error when providing a non open access pmcid', function(done){
    
    var ldpm = new Ldpm(conf,path.join(root,'__tests'));
    fs.mkdir('__tests', function(err){
      if(err) console.log(err);
      ldpm.convert('PMC3884567', function(err,pkg){
        assert.equal(err.code, 404);
        rimraf('__tests',function(err){
          if(err) console.log(err);
          done();
        });
      });
    });

  });

  it('should replace contentPaths with contentUrls when article comes from plos', function(done){
    var ldpm = new Ldpm(conf,path.join(root,'__tests'));
    fs.mkdir('__tests', function(err){
      if(err) console.log(err);
      ldpm.convert('PMC3897745', function(err,pkg){
        if(err) console.log(err);
        pkg.figure.forEach(function(f){
          f.figure.forEach(function(x){
            assert(x.contentUrl);
            assert(!x.contentPath);
          })
        })
        rimraf('__tests',function(err){
          if(err) console.log(err);
          done();
        });
      });
    });
  });

});
