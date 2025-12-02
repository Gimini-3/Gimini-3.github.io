---
title: "[Java Multithreading] Part 3 – JVM이 OS 스레드를 만드는 과정: JavaThread, os::create_thread, pthread_create, glibc, clone()"
date: 2025-10-04 08:30:00 +0900
tags: 
  - java
  - concurrency
  - thread
  - start
  - run
  - jvm
thumbnail: "/assets/img/thumbnail/thread-start.png"
---
# [Java Multithreading] Part 3 – JVM이 OS 스레드를 만드는 과정: JavaThread, os::create_thread, pthread_create, glibc, clone()

## 0. 이번 파트에서 보는 것

Part 2에서 여기까지 내려왔다:

> Thread.start()
>
>
> → `start0()` (native)
>
> → `JVM_StartThread`
>
> → `new JavaThread(thread_entry, stackSize)`
>
> → `Thread::start(native_thread)` 호출 직전
>

이제 **“JVM이 실제 OS 스레드를 어떻게 만드는지”**를 따라갈 차례다.

이번 Part 3에서 다룰 범위는:

- `JavaThread` 생성자 안에서 호출되는 `os::create_thread(...)`
- `OSThread` 생성, `pthread_attr` 설정, `pthread_create` 호출
- 그 아래에서 glibc가 `clone()` 시스템콜로 리눅스 커널에 스레드 생성 요청하는 흐름
- 정리: **HotSpot 레벨 ↔ glibc 레벨 ↔ 커널 레벨** 세 층 구조

“새 스레드를 만든다”는 한 줄이

실제로는 **세 겹**을 타고 내려가는 일이라는 걸 보는 파트다.

---

## 1. Part 2 끝에서 우리는 어디까지 왔나?

Part 2 마지막 지점부터 다시 한 번 흐름을 짚어보면:

```
Thread.start()       // 자바
  → start0()         // native
    → JVM_StartThread(JNIEnv* env, jobject jthread)  // HotSpot C++
      → new JavaThread(&thread_entry, stackSize)     // JVM 내부 스레드 객체 생성
      → JavaThread::prepare(jthread)                 // 자바 Thread와 연결
      → Thread::start(native_thread)                 // 실행 상태 전환 + OS 스레드 시작

```

오늘 보는 핵심은 이 줄 속에서:

```cpp
native_thread = new JavaThread(&thread_entry, sz);

```

**이 한 줄이 실제로 OS 스레드를 어떻게 만드는지**이다.

---

## 2. JavaThread 생성자: 여기서 `os::create_thread(...)`가 호출된다

HotSpot의 `JavaThread` 생성자는 대략 이런 구조다 (불필요한 부분을 많이 생략한 버전):

```cpp
// openjdk/jdk/src/hotspot/share/runtime/javaThread.cpp

JavaThread::JavaThread(ThreadFunction entry_point, size_t stack_sz, MemTag mem_tag)
  : JavaThread(mem_tag) {

  set_entry_point(entry_point); // 나중에 실행할 엔트리 포인트 (보통 thread_entry)

  // 어떤 타입의 스레드인지 결정
  os::ThreadType thr_type = os::java_thread;
  if (entry_point == &CompilerThread::thread_entry) {
    thr_type = os::compiler_thread;
  } else {
    thr_type = os::java_thread;
  }

  // 실제 OS 스레드 생성 시도
  os::create_thread(this, thr_type, stack_sz);

  // 이 시점에서 _osthread는 null일 수도 있다 (리소스 부족 등)
  // 실패 여부 확인은 상위(JVM_StartThread)에서 한다.
}

```

### 2-1. `ThreadFunction entry_point` – 스레드가 살아나면 제일 먼저 들어갈 함수

- `entry_point`는 **“이 스레드가 본격적으로 돌기 시작했을 때 호출할 함수 포인터”**다.
- 일반 자바 스레드의 경우 `thread_entry`가 들어온다.
    - `thread_entry(JavaThread*, TRAPS)` 안에서 최종적으로 자바의 `Thread.run()`을 호출한다.
    - `thread_entry` 자세한 내용은 Part 4에서 본다.

### 2-2. `os::ThreadType` – 스레드 종류(역할)에 따라 타입 분류

HotSpot은 스레드를 종류별로 구분한다:

```cpp
enum ThreadType {
  java_thread,       // 일반 애플리케이션 자바 스레드 (new Thread())
  compiler_thread,   // JIT 컴파일러 전용 스레드
  vm_thread,         // VM 관리용 스레드
  gc_thread,         // GC 워커 스레드
  watcher_thread,    // WatcherThread (주기적 모니터링)
  os_thread          // 기타 OS 내부용 스레드
};

```

- 우리가 `new Thread(...).start()`로 만드는 건 대부분 `java_thread`.
- JIT 컴파일러(C1/C2 등)용 스레드는 `compiler_thread`.
- GC, VM, Watcher 등도 각자 타입을 나눠 관리한다.

이 타입 정보는:

- 스택 크기 기본값
- guard page 크기
- 스케줄링/디버깅 옵션

등을 결정할 때 사용된다.

### 2-3. `os::create_thread(this, thr_type, stack_sz);`

> “지금 이 JavaThread를 실제 OS 스레드와 연결해서
>
>
> 실행 가능한 상태로 만들어 줘.”
>

라고 OS 의존 레이어에 요청하는 함수다.

---

## 3. `os::create_thread` 내부 (Linux 기준)

이제 리눅스 구현을 보자.

```cpp
// openjdk/jdk/src/hotspot/os/linux/os_linux.cpp

bool os::create_thread(Thread* thread, ThreadType thr_type, size_t req_stack_size) {
  // 1. OSThread 생성 및 연결
  OSThread* osthread = new (std::nothrow) OSThread();
  if (osthread == nullptr) return false;
  osthread->set_state(ALLOCATED);
  thread->set_osthread(osthread);

  // 2. pthread 속성 초기화
  pthread_attr_t attr;
  if (pthread_attr_init(&attr) != 0) {
    thread->set_osthread(nullptr);
    delete osthread;
    return false;
  }
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  // 3. 스택 크기 계산 및 설정
  size_t stack_size = os::Posix::get_initial_stack_size(thr_type, req_stack_size);
  size_t guard_size = os::Linux::default_guard_size(thr_type);
  pthread_attr_setguardsize(&attr, guard_size);
  pthread_attr_setstacksize(&attr, stack_size);

  // 4. pthread_create 호출
  pthread_t tid;
  int ret = pthread_create(&tid, &attr,
                           (void* (*)(void*)) thread_native_entry,
                           thread);

  pthread_attr_destroy(&attr);

  if (ret != 0) {
    thread->set_osthread(nullptr);
    delete osthread;
    return false;
  }

  // 5. 성공 시 OSThread에 pthread ID 기록
  osthread->set_pthread_id(tid);

  // 6. 자식 스레드 초기화 대기
  {
    Monitor* sync_with_child = osthread->startThread_lock();
    MutexLocker ml(sync_with_child, Mutex::_no_safepoint_check_flag);
    while (osthread->get_state() == ALLOCATED) {
      sync_with_child->wait_without_safepoint_check();
    }
  }

  // 7. INITIALIZED 상태에서 true 반환
  return true;
}

```

이걸 단계별로 풀어보자.

---

## 4. 1단계 – `OSThread` 생성: OS 핸들을 관리할 껍데기

```cpp
OSThread* osthread = new (std::nothrow) OSThread();
if (osthread == nullptr) return false;
osthread->set_state(ALLOCATED);
thread->set_osthread(osthread);

```

- 여기서 `OSThread`는 **OS 스레드 핸들을 감싸는 HotSpot 내부 객체**다.
    - pthread ID, native thread id, 시작 동기화용 모니터, 상태값 등을 가진다.
- 이 시점에는 아직 OS 스레드를 만들지 않았다.
- 상태를 `ALLOCATED`로 두고, `JavaThread` 쪽과 연결만 해둔다.

그림으로 보면:

```
JavaThread
  └─ OSThread (state = ALLOCATED)
       └─ (아직 OS thread 없음)

```

---

## 5. 2단계 – `pthread_attr_t` 초기화 + detach 모드 설정

```cpp
pthread_attr_t attr;
if (pthread_attr_init(&attr) != 0) {
  ...
}
pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

```

`PTHREAD_CREATE_DETACHED`를 쓰면 **detached 스레드**가 만들어진다.

- **joinable 스레드 (기본값)**
    - joinable 스레드를 만들면, 그 스레드가 끝나도 커널 안에 스레드 관련 정보가 남아 있다.
    - 그래서 언젠가는 `pthread_join(tid, NULL);`을 호출해 줘야 한다.
        - 이때 이 스레드가 다 끝났는지 확인하고 동시에 리소스를 정리해 준다.
    - 언제 쓰는가?
        - 이 스레드가 언제 끝나는지 반드시 알고 싶다.
        - 이 스레드 결과를 받아서 다음 작업을 하고 싶다.
        - 스레드가 다 끝난 뒤에 프로그램을 종료하고 싶다.
- **detached 스레드**
    - 언제 끝났는지 직접 확인하는 용도가 아니다.
    - 스레드가 끝나는 순간, OS가 이 스레드는 끝났다 하고 바로 관련 리소스를 정리한다.
    - 그래서 나중에 `pthread_join(tid, ...)`을 부를 수 없다.
    - 이미 정리된 정보라서 더 이상 joint 대상이 아니기 때문이다.
    - 언제 쓰는가?
        - 이 스레드가 언제 끝나는지 정확한 시점을 알 필요 없다.
        - 그냥 백그라운드에서 한 번 돌고 끝나면 된다.

한 줄 요약하면:

> joinable = “내가 직접 join해서 치우는 스레드”
>
>
> detached = “끝나면 OS가 알아서 치우는 스레드”
>

---

### JVM이 내부 스레드를 detached로 자주 만드는 이유

HotSpot JVM이 내부에서 OS 스레드를 만들 때는, 보통 이렇게 생각하면 된다.

- 자바 코드에서 `pthread_join()`을 직접 호출할 일은 없다.
- OS 스레드의 생명주기/리소스 정리는 **JVM이 전체적으로 관리**한다.
- 자바 개발자는 **`Thread.join()` 같은 자바 API만** 쓰면 된다.

그래서 JVM 입장에서는:

- OS 레벨에서는 **detached**로 만들어 두면

  → 스레드가 끝날 때 커널이 자동으로 리소스를 정리해 준다.

- 자바 레벨에서는

  → “저 Thread가 끝났는지”는 `JavaThread`/`Thread` 상태로 관리하고

  → `join()`이 오면 wait/notify로 자바 쪽에서만 기다리도록 구현한다.


즉,

> OS 레벨 리소스 청소 = detached + 커널
>
>
> 자바 레벨 동기화/대기 = JVM + `Thread.join()`
>

으로 역할을 분리해 둔 구조라고 보면 된다.

---

### Java `join()` vs `pthread_join()` 차이

**`pthread_join()` (C/POSIX)**

- 대상 OS 스레드가 끝날 때까지 **현재 스레드를 블록**시키고,
- 동시에 그 스레드의 커널 리소스를 회수한다.
- “OS 스레드에 직접 붙어서 기다리는 함수”

**`Thread.join()` (Java)**

- OS 함수 래핑이 아니라, **JVM이 구현한 고수준 동기화 메서드**다.
- 내부적으로는
    - `JavaThread` / 자바 `Thread`의 **상태**를 보고
    - 아직 안 끝났으면 `wait/notify` 패턴으로 블록시킨다.
- OS 레벨 `pthread_join()`을 직접 호출해서 자바 스레드마다 join하는 구조가 아니다.

그래서 Java 관점에서는:

> “OS 스레드를 join한다기보다는,
>
>
> **JVM이 관리하는 ‘자바 스레드 상태’가 끝날 때까지 기다린다**”
>

---

## 6. 3단계 – 스택 크기 & 가드 페이지 설정

```cpp
size_t stack_size = os::Posix::get_initial_stack_size(thr_type, req_stack_size);
size_t guard_size = os::Linux::default_guard_size(thr_type);
pthread_attr_setguardsize(&attr, guard_size);
pthread_attr_setstacksize(&attr, stack_size);

```

- `tack_size` → 이 스레드가 사용할 스택 크기를 최종 결정
- `guard_size` → 스택 끝에 둘 “보호용 메모리 영역” 크기 결정
- 둘 다 `pthread_attr_t`에 반영해서 `pthread_create`할 때 같이 넘김

---

### A. 스택 크기 결정 – “얼마만큼 스택을 쓸지 최종 확정”

스레드마다 **자기만 쓰는 스택 메모리**가 있다.

여기서 하는 일:

1. 자바에서 `new Thread(null, runnable, "t", stackSize)` 같은 식으로

   stackSize를 직접 지정했을 수도 있고, 안 했을 수도 있다.

2. JVM은 `req_stack_size`(요청값)와
    - JVM 기본값
    - OS가 허용하는 최소/최대 스택 크기

      를 모두 고려해서 **최종 stack_size**를 만든다.

3. `pthread_attr_setstacksize(&attr, stack_size)`로

   “이 스레드는 이만큼 스택을 쓰겠다”고 명시해 준다.


이걸 안 하고 OS 기본값만 쓰면,

- 어떤 환경에서는 스택이 **너무 작아서** 금방 터질 수도 있고,
- 반대로 **너무 크게 잡혀서** 불필요하게 메모리를 많이 점유할 수도 있다.

그래서 JVM이 **“JVM이 원하는 기준”에 맞춰 스택 크기를 컨트롤**하는 거라고 보면 된다.

### B. 가드 페이지(guard page) – “스택 오버플로를 잡아내기 위한 안전 장치”

`guard_size`는 **가드 페이지 크기**다.

- 스택의 끝 부분에 **일부 페이지를 “접근 불가 메모리”로 막아 두는 것**이다.
- 코드가 스택을 너무 많이 써서 **스택 끝을 넘어서면**:
    - 그 막아 둔 영역을 건드리게 되고
    - 즉시 SIGSEGV(세그멘테이션 폴트)가 나면서 프로세스가 죽거나,

      JVM이 “스택 오버플로 발생”을 감지할 수 있게 된다.


정리하면:

- 가드 페이지가 있으면

  → “스택 끝을 넘는 순간 바로 터져서, 문제 지점을 빨리 알 수 있다.”

- 가드 페이지가 없으면

  → 스택을 넘어서 다른 메모리까지 침범해 버려서

  **조용히 메모리를 망가뜨리고**, 나중에 엉뚱한 곳에서 터져 디버깅이 어려워진다.


---

## 7. 4단계 – 핵심: `pthread_create` 호출

```cpp
pthread_t tid;
int ret = pthread_create(&tid, &attr,
                         (void* (*)(void*)) thread_native_entry,
                         thread);
```

여기가 “새 OS 스레드 하나 주세요”라고 OS에 요청하는 부분이다.

- 첫 번째 인자 `&tid`

  → 새로 만들어지는 스레드의 pthread ID를 돌려받을 변수 주소

  → `pthread_create`가 성공하면 이 변수에 새 스레드 ID를 넣어 준다.

- 두 번째 인자 `&attr`

  → 방금 설정한 스택/가드/detach 속성.

  → 이걸 넘기면 OS가 이 옵션대로 스레드를 만든다.

- 세 번째 인자 `thread_native_entry`

  → **새 스레드가 시작하면 제일 먼저 실행할 함수 주소**

    - OS 입장에서는 새 스레드를 만들고, 그 스레드에서 이 함수를 호출하게 한다.
    - 이 함수 안에서  JVM이 초기화 작업을 하고, 자바 쪽 `Thread.run()`까지 연결해 준다.
- 네 번째 인자 `thread`

  → start routine에 전달할 인자 (여기서는 `Thread*`, 보통 `JavaThread*`).


`thread_native_entry`는 HotSpot 안에 정의된 함수로,

**새로 생성된 OS 스레드가 바로 들어가는 C 함수**다. (이건 Part 4에서 깊게 본다.)

### 7-1. 실패 처리

```cpp
pthread_attr_destroy(&attr);

if (ret != 0) {
  thread->set_osthread(nullptr);
  delete osthread;
  return false;
}

```

- 스레드 생성이 실패하면:
    - `osthread`를 정리하고
    - `false` 를 반환해서 상위(`JavaThread` → `JVM_StartThread`)에서

      `OutOfMemoryError("Failed to create native thread")` 를 던질 수 있도록 한다.

        ```cpp
        // JVM_StartThread() 메서드 내 코드
           JavaThread* native_thread = nullptr;
           ...
           ...
           if (native_thread->osthread() == nullptr) {
            THROW_MSG(vmSymbols::java_lang_OutOfMemoryError(), "Failed to create native thread");
           }
        ```


---

## 8. 5단계 – 성공한 경우: `OSThread`에 pthread ID 기록 + 자식 초기화 대기

스레드 생성이 성공했다면:

```cpp
osthread->set_pthread_id(tid);
```

- `OSThread`에 pthread ID를 기록한다.
- 디버깅/로그/시그널 라우팅 등에 사용된다.

그리고 바로 **자식(새 스레드)의 초기화를 기다리는 단계**로 들어간다.

```cpp
{
  Monitor* sync_with_child = osthread->startThread_lock();
  MutexLocker ml(sync_with_child, Mutex::_no_safepoint_check_flag);
  while (osthread->get_state() == ALLOCATED) {
    sync_with_child->wait_without_safepoint_check();
  }
}
```

여기서 중요한 포인트:

- 부모(현재 `os::create_thread`를 실행 중인 스레드)는
    - `startThread_lock` 라는 모니터(뮤텍스 + 조건변수)를 잡고,
    - `OSThread` 상태가 `ALLOCATED` 에서 다른 상태로 바뀔 때까지 기다린다.
- 자식(새로 만들어진 OS 스레드)은
    - `thread_native_entry` 안에서 초기화 작업을 수행한 뒤,
    - `OSThread` 상태를 `INITIALIZED` 등으로 바꾸고,
    - 같은 `startThread_lock` 모니터에서 `notify()`를 호출해 부모를 깨운다.

즉, 이 단계는:

> “스레드는 이미 만들어졌는데,
>
>
> 자식이 최소한의 VM 초기화(`OSThread` 상태 세팅 등)를 끝낼 때까지
>
> 부모가 잠깐 기다리는 구간”
>

이라고 보면 된다.

자식이 `INITIALIZED` 상태까지 올라간 뒤에야

상위에서 `Thread::start` → `os::start_thread` → `pd_start_thread` 를 호출하여

**실제 `RUNNABLE` 상태로 전환**시킬 수 있다.

(이 start barrier와 핸드셰이크 세부 내용은 Part 4에서 연결된다.)

---

## 9. glibc란 무엇이고, 왜 `pthread_create`를 쓰는가?

지금까지는 HotSpot 코드 레벨이었다.

하지만 `pthread_create` 자체도 “사용자 공간 라이브러리 함수”다.

한 단계 더 내려가보자.

### 9-1. glibc = GNU C Library

- 리눅스에서 가장 널리 쓰이는 **표준 C 라이브러리 구현**.
- 우리가 C에서 쓰는 대부분의 함수:
    - `printf`, `malloc`, `free`
    - `open`, `read`, `write`
    - `pthread_create`, `pthread_join`

      전부 glibc 안에 들어 있다.


역할:

- 각종 시스템 콜(syscall)을 감싸서 **이식성 있고 쓰기 편한 API**를 제공한다.
- 직접 `syscall` 어셈블리로 호출하는 대신,
    - glibc 함수 하나로 OS 의존성을 숨기고,
    - POSIX/ISO C 표준 인터페이스를 맞춰준다.

### 9-2. JVM이 `clone()`을 직접 호출하지 않고 `pthread_create`를 쓰는 이유

리눅스 커널에서 스레드/프로세스를 만드는 시스템콜은 `clone()` 이다.

그런데 HotSpot은 대부분 이걸 직접 쓰지 않고, **`pthread_create`** 를 사용한다.

이유:

1. POSIX 호환
    - `pthread` API는 POSIX 표준에 맞게 설계되어 있고,
    - 다른 유닉스 계열 OS에서도 거의 동일하게 동작한다.
2. 이식성
    - JVM은 여러 유닉스 계열(리눅스, BSD, macOS 등)을 지원해야 한다.
    - 각각의 커널 syscall을 직접 다루는 것보다는

      `pthread_*` 계열 API 위에 얹는 게 훨씬 유지보수에 좋다.

3. 추가 편의 기능
    - `pthread_create`는 단순히 `clone()`만 감싸는 게 아니라,
        - 스레드 속성,
        - signal mask,
        - TLS 초기화 등

          여러 준비 작업을 함께 처리해 준다.


정리하면:

> HotSpot(유저 공간 프로그램)이 OS 스레드를 만들 때
>
>
> glibc가 제공하는 `pthread_create`를 사용하고,
>
> glibc는 내부에서 `clone()` 시스템콜로 커널에 요청한다.
>

---

## 10. 커널 레벨 – `clone()` 시스템콜과 task_struct

이제 마지막 레벨, 리눅스 커널.

### 10-1. `clone()` 시스템콜

- 리눅스에서 **프로세스/스레드 생성**에 쓰이는 시스템콜이다.
- `fork()`와 달리, 어떤 자원을 부모와 공유할지 플래그로 지정할 수 있다.
    - `CLONE_VM` → 주소 공간 공유 (스레드)
    - `CLONE_FILES` → 열린 파일 디스크립터 공유
    - `CLONE_SIGHAND` → 시그널 핸들 공유
- 일반적인 POSIX 스레드 구현에서는 이 플래그들을 적절히 조합해

  “**같은 프로세스 안에서 주소 공간을 공유하는 스레드**”를 만든다.


### 10-2. 커널 내부에서 하는 일 (개념적으로)

1. 새 `task_struct` 할당
    - 리눅스 커널에서 스레드/프로세스를 나타내는 구조체.
2. 부모의 주소 공간, 파일, 시그널 핸들 등을 공유/복사할지 플래그에 따라 처리.
3. 스택/레지스터 초기값 세팅
4. 스케줄러 큐에 새 task 등록

그리고:

- 시스템콜이 성공하면 부모 쪽에는 새 스레드 ID를 반환하고,
- 자식 쪽에서는 지정된 start routine의 첫 줄부터 실행을 시작한다.

---

## 11. 세 레벨 요약: HotSpot ↔ glibc ↔ 커널

지금까지의 흐름을 한 번에 정리하면:

```
[HotSpot 레벨]  (OpenJDK / libjvm.so)
---------------------------------------
JVM_StartThread
  → new JavaThread(thread_entry, stackSize)
      → os::create_thread(this, thr_type, stackSize)
          → pthread_attr_init / setstacksize / setguardsize
          → pthread_create(&tid, &attr, thread_native_entry, thread)
              ↓

[glibc 레벨]    (libpthread.so / glibc)
---------------------------------------
pthread_create(...)
  → clone(...) 시스템콜 래퍼
      ↓

[커널 레벨]     (Linux kernel)
---------------------------------------
clone(...)
  → task_struct 생성
  → 주소 공간/파일/시그널 공유 설정
  → 스케줄러에 새 스레드 등록
  → 새 스레드에서 start routine(thread_native_entry) 실행 시작

```

이렇게 보면, 우리가 자바에서 친 **`t.start()` 한 줄**이:

1. JVM C++ 코드 (`JavaThread`, `OSThread`)
2. glibc (`pthread_create`)
3. 리눅스 커널 (`clone`, `task_struct`, 스케줄러)

를 층층이 타고 내려가면서 OS 스레드를 만드는 동작이라는 게 보인다.

Part 3는 이 중에서 “HotSpot → glibc → 커널로 내려가는 과정”까지.

Part 4에서는 새로 만들어진 스레드가

`thread_native_entry` → `JavaThread::run` → `thread_entry` → `Thread.run()` 으로

**다시 자바 세계로 올라오는 길**을 따라갈 예정이다.

---

## 12. Part 3 정리

핵심만 다시 뽑으면:

1. `JavaThread` 생성자에서 `os::create_thread(this, thr_type, stackSize)` 호출
2. `os::create_thread` (Linux 기준):
    - `OSThread` 객체 생성, 상태 `ALLOCATED`
    - `pthread_attr_t` 초기화, detach 모드 설정
    - 스택 크기, 가드 페이지 설정
    - `pthread_create(&tid, &attr, thread_native_entry, thread)` 호출
    - 성공 시 `OSThread`에 pthread ID 저장
    - `startThread_lock` 모니터로 자식 스레드 초기화 완료까지 대기
3. `pthread_create`는 glibc 함수로, 내부에서 `clone()` 시스템콜을 호출
4. 리눅스 커널은 `clone()`을 통해 새 `task_struct`를 만들고,

   스케줄러에 등록한 뒤, 새 스레드에서 `thread_native_entry`를 실행 시작

5. 이렇게 해서 자바의 `Thread` 객체는

   JVM 내부 `JavaThread` ↔ `OSThread` ↔ OS 커널 스레드와 1:1로 연결된다 (플랫폼 스레드 기준).