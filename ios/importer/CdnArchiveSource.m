//
//  CdnArchiveSource.m
//

#import "CdnArchiveSource.h"

#import <CommonCrypto/CommonDigest.h>
#import <errno.h>
#import <fcntl.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

#pragma mark - 文件源

@implementation CdnFileSource {
    int _fd;
    uint64_t _length;
}

+ (nullable instancetype)sourceWithPath:(NSString *)path error:(NSError **)error {
    if (path.length == 0) {
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"空路径");
        return nil;
    }
    int fd = open(path.fileSystemRepresentation, O_RDONLY);
    if (fd < 0) {
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"打不开 %@: %s", path, strerror(errno));
        return nil;
    }
    struct stat info;
    if (fstat(fd, &info) != 0) {
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"fstat 失败 %@: %s", path, strerror(errno));
        close(fd);
        return nil;
    }
    if (!S_ISREG(info.st_mode)) {
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"不是普通文件: %@", path);
        close(fd);
        return nil;
    }
    CdnFileSource *source = [[CdnFileSource alloc] init];
    source->_fd = fd;
    source->_length = (uint64_t)info.st_size;
    source->_path = [path copy];
    return source;
}

- (uint64_t)length {
    return _length;
}

- (nullable NSData *)readAtOffset:(uint64_t)offset length:(NSUInteger)length error:(NSError **)error {
    if (length == 0) return [NSData data];
    if (offset >= _length) return [NSData data];
    uint64_t available = _length - offset;
    NSUInteger want = (NSUInteger)(available < (uint64_t)length ? available : (uint64_t)length);
    NSMutableData *data = [NSMutableData dataWithLength:want];
    uint8_t *bytes = data.mutableBytes;
    NSUInteger got = 0;
    while (got < want) {
        ssize_t count = pread(_fd, bytes + got, want - got, (off_t)(offset + got));
        if (count < 0) {
            if (errno == EINTR) continue;
            if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"读 %@ 失败(off=%llu): %s", _path, offset + got, strerror(errno));
            return nil;
        }
        if (count == 0) break;
        got += (NSUInteger)count;
    }
    if (got < want) data.length = got;
    return data;
}

- (void)close {
    if (_fd >= 0) {
        close(_fd);
        _fd = -1;
    }
}

- (void)dealloc {
    [self close];
}

@end

#pragma mark - 内存源

@implementation CdnMemorySource {
    NSData *_data;
}

+ (instancetype)sourceWithData:(NSData *)data {
    CdnMemorySource *source = [[CdnMemorySource alloc] init];
    source->_data = [data copy] ?: [NSData data];
    return source;
}

- (uint64_t)length {
    return (uint64_t)_data.length;
}

- (nullable NSData *)readAtOffset:(uint64_t)offset length:(NSUInteger)length error:(NSError **)error {
    if (length == 0 || offset >= (uint64_t)_data.length) return [NSData data];
    NSUInteger start = (NSUInteger)offset;
    NSUInteger want = MIN(length, _data.length - start);
    return [_data subdataWithRange:NSMakeRange(start, want)];
}

@end

#pragma mark - 拼接源

@implementation CdnConcatSource {
    NSArray<NSNumber *> *_prefix;   // _prefix[i] = 第 i 个源的起始逻辑偏移，末尾多一个总长度
}

+ (instancetype)sourceWithSources:(NSArray<id<CdnArchiveSource>> *)sources {
    CdnConcatSource *source = [[CdnConcatSource alloc] init];
    source->_sources = [sources copy] ?: @[];
    NSMutableArray<NSNumber *> *prefix = [NSMutableArray arrayWithCapacity:sources.count + 1];
    uint64_t cursor = 0;
    [prefix addObject:@(cursor)];
    for (id<CdnArchiveSource> item in source->_sources) {
        cursor += item.length;
        [prefix addObject:@(cursor)];
    }
    source->_prefix = prefix;
    return source;
}

- (uint64_t)length {
    return [_prefix.lastObject unsignedLongLongValue];
}

- (NSUInteger)indexOfSourceForOffset:(uint64_t)offset {
    NSUInteger low = 0;
    NSUInteger high = _sources.count;
    while (low + 1 < high) {
        NSUInteger middle = (low + high) / 2;
        if ([_prefix[middle] unsignedLongLongValue] <= offset) {
            low = middle;
        } else {
            high = middle;
        }
    }
    return low;
}

- (nullable NSData *)readAtOffset:(uint64_t)offset length:(NSUInteger)length error:(NSError **)error {
    uint64_t total = self.length;
    if (length == 0 || offset >= total) return [NSData data];
    NSMutableData *result = [NSMutableData dataWithCapacity:MIN(length, (NSUInteger)(1 << 20))];
    uint64_t cursor = offset;
    NSUInteger remaining = length;
    while (remaining > 0 && cursor < total) {
        NSUInteger index = [self indexOfSourceForOffset:cursor];
        if (index >= _sources.count) break;
        uint64_t base = [_prefix[index] unsignedLongLongValue];
        id<CdnArchiveSource> item = _sources[index];
        uint64_t local = cursor - base;
        if (local >= item.length) break;
        uint64_t available = item.length - local;
        NSUInteger want = (NSUInteger)MIN((uint64_t)remaining, available);
        NSData *chunk = [item readAtOffset:local length:want error:error];
        if (chunk == nil) return nil;
        if (chunk.length == 0) break;
        [result appendData:chunk];
        cursor += chunk.length;
        remaining -= chunk.length;
    }
    return result;
}

@end

#pragma mark - 窗口源

@implementation CdnSubrangeSource {
    id<CdnArchiveSource> _source;
    uint64_t _length;
}

+ (nullable instancetype)sourceWithSource:(id<CdnArchiveSource>)source
                                   offset:(uint64_t)offset
                                   length:(uint64_t)length {
    if (source == nil) return nil;
    if (offset > source.length) return nil;
    uint64_t available = source.length - offset;
    CdnSubrangeSource *window = [[CdnSubrangeSource alloc] init];
    window->_source = source;
    window->_offset = offset;
    window->_length = MIN(length, available);
    return window;
}

- (uint64_t)length {
    return _length;
}

- (nullable NSData *)readAtOffset:(uint64_t)offset length:(NSUInteger)length error:(NSError **)error {
    if (length == 0 || offset >= _length) return [NSData data];
    uint64_t available = _length - offset;
    NSUInteger want = (NSUInteger)MIN((uint64_t)length, available);
    return [_source readAtOffset:_offset + offset length:want error:error];
}

@end

#pragma mark - 工具

BOOL CdnReadExactly(id<CdnArchiveSource> source,
                    uint64_t offset,
                    void *buffer,
                    NSUInteger length,
                    NSUInteger *outRead,
                    NSError **error) {
    NSUInteger got = 0;
    uint8_t *bytes = (uint8_t *)buffer;
    if (bytes == NULL && length > 0) {
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"内部错误：缓冲区为空");
        return NO;
    }
    while (got < length) {
        NSUInteger want = MIN((NSUInteger)(1 << 20), length - got);
        NSData *chunk = [source readAtOffset:offset + got length:want error:error];
        if (chunk == nil) return NO;
        if (chunk.length == 0) break;
        memcpy(bytes + got, chunk.bytes, chunk.length);
        got += chunk.length;
    }
    if (outRead != NULL) *outRead = got;
    return YES;
}

NSData * _Nullable CdnReadData(id<CdnArchiveSource> source, uint64_t offset, NSUInteger length, NSError **error) {
    if ((uint64_t)length > source.length || offset > source.length - (uint64_t)length) {
        if (error != NULL) {
            *error = CdnError(CdnImporterErrorFormat, @"读取越界：off=%llu len=%lu (总长 %llu)",
                              offset, (unsigned long)length, source.length);
        }
        return nil;
    }
    NSUInteger got = 0;
    NSMutableData *result = [NSMutableData dataWithLength:length];
    if (result == nil) {
        // 分配失败必须在这里拦下：dataWithLength: 失败会返回 nil，接着把 NULL 交给
        // CdnReadExactly 的 memcpy 就是宿主进程里的 SIGSEGV。
        if (error != NULL) {
            *error = CdnError(CdnImporterErrorIO, @"内存不足：无法分配 %lu 字节", (unsigned long)length);
        }
        return nil;
    }
    if (!CdnReadExactly(source, offset, result.mutableBytes, length, &got, error)) return nil;
    if (got < length) {
        if (error != NULL) {
            *error = CdnError(CdnImporterErrorFormat, @"读取越界：off=%llu want=%lu got=%lu (总长 %llu)",
                              offset, (unsigned long)length, (unsigned long)got, source.length);
        }
        return nil;
    }
    return result;
}

uint16_t CdnReadLE16(const uint8_t *bytes, NSUInteger offset) {
    return (uint16_t)(bytes[offset] | ((uint16_t)bytes[offset + 1] << 8));
}

uint32_t CdnReadLE32(const uint8_t *bytes, NSUInteger offset) {
    return (uint32_t)bytes[offset]
         | ((uint32_t)bytes[offset + 1] << 8)
         | ((uint32_t)bytes[offset + 2] << 16)
         | ((uint32_t)bytes[offset + 3] << 24);
}

uint64_t CdnReadLE64(const uint8_t *bytes, NSUInteger offset) {
    uint64_t value = 0;
    for (NSUInteger index = 0; index < 8; index++) {
        value |= ((uint64_t)bytes[offset + index]) << (8 * index);
    }
    return value;
}

NSString * _Nullable CdnSHA256Base64OfSource(id<CdnArchiveSource> source, NSError **error) {
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    const NSUInteger chunkSize = 1 << 20;
    uint64_t offset = 0;
    while (offset < source.length) {
        NSUInteger want = (NSUInteger)MIN((uint64_t)chunkSize, source.length - offset);
        NSData *chunk = [source readAtOffset:offset length:want error:error];
        if (chunk == nil) return nil;
        if (chunk.length == 0) break;
        CC_SHA256_Update(&context, chunk.bytes, (CC_LONG)chunk.length);
        offset += chunk.length;
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    NSData *data = [NSData dataWithBytes:digest length:sizeof(digest)];
    return [data base64EncodedStringWithOptions:0];
}
