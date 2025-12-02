---
title: "[Java Multithreading] Part 4 – 새로운 스레드가 자바 run()에 도달하기까지: thread_native_entry → JavaThread::run → thread_entry → Thread.run()"
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

# [Java Multithreading] Part 4 – 새로운 스레드가 자바 run()에 도달하기까지: thread_native_entry → JavaThread::run → thread_entry → Thread.run()

### 시리즈 전체 보기

- [Part 1 – Thread.start() vs run() : 자바 코드 + 간단한 흐름 비교]({% link _pages/Java/java-thread-start-part1-start-vs-run-code-and-flow.md %})
- [Part 2 – Thread.start() 뒤에서 일어나는 일: start0() ~ JVM_StartThread ~ JavaThread]({% link _pages/Java/java-thread-start-part2-start0-jvm-startthread-javathread.md %})
- [Part 3 – JVM이 OS 스레드를 만드는 과정: JavaThread, os::create_thread, pthread_create, glibc, clone()]({% link _pages/Java/java-thread-start-part3-os-create-thread-pthread-glibc-clone.md %})
- [Part 4 – 새로운 스레드가 자바 run()에 도달하기까지:  thread_native_entry → JavaThread::run → thread_entry → Thread.run()]({% link _pages/Java/java-thread-start-part4-thread-entry-to-run.md %})
- [마지막 글 – 스레드 관점에서 한눈에 정리: new → start → run → 종료 후 상태]({% link _pages/Java/java-thread-start-part5-thread-lifecycle-summary.md %})



## 0. 이번 파트에서 볼 것

Part 3까지의 흐름은 여기까지였다:

- `Thread.start()`

  → `start0()` (native)

  → `JVM_StartThread`

  → `new JavaThread(thread_entry, stackSize)`

  → `os::create_thread`

  → `pthread_create(..., thread_native_entry, thread)`

  → **OS 커널이 새 스레드를 만들고, 그 스레드가 `thread_native_entry`로 진입**


이제 Part 4에서는:

> “새로 만들어진 OS 스레드가 어떻게 자바 코드인 Thread.run()까지 올라오는지”
>

를 따라간다.

구체적으로:

- `thread_native_entry(Thread* thread)`
- `JavaThread::run()`
- `JavaThread::thread_main_inner()`
- `thread_entry(JavaThread*, TRAPS)`
- 최종적으로 자바의 `Thread.run()` 호출

까지를 쭉 따라가면서, **부모/자식 스레드 동기화, start barrier, Handle/예외 컨텍스트, run() 호출 과정**을 정리한다.

---

## 1. 다시 출발점 정리: pthread_create 이후 상황

Part 3에서 `os::create_thread`는 아래 코드를 통해 OS 스레드를 만들었다:

```cpp
// openjdk/jdk/src/hotspot/os/linux/os_linux.cpp
bool os::create_thread(Thread* thread, ThreadType thr_type, size_t req_stack_size) {
	...
	pthread_t tid;
	int ret = pthread_create(&tid, &attr,
	                         (void* (*)(void*)) thread_native_entry,
	                         thread);
	...
}
```

여기서 중요한 점:

- **새로 만들어진 OS 스레드**는
    - 바로 `thread_native_entry` 함수로 들어간다.
- 네 번째 인자는 `thread` (보통 `JavaThread*`).
    - 즉, 새 스레드는 `thread_native_entry(JavaThread*)`를 실행하기 시작한다.

이제 **자식 스레드 입장**에서 남은 경로는:

1. `thread_native_entry(thread)` 진입
2. HotSpot 내부 초기화 + 부모와 start barrier 핸드셰이크
3. `thread->call_run()` 호출
4. `JavaThread::run()` → `thread_main_inner()`
5. `entry_point`(= `thread_entry`) 호출
6. `thread_entry`에서 `Thread.run()` 호출

이 순서를 하나씩 뜯어본다.

---

## 2. 부모 입장 마지막 단계: Thread::start → os::start_thread → pd_start_thread

먼저, **부모(기존 스레드)** 입장에서 마무리 작업을 다시 보자.

```cpp
JVM_ENTRY(void, JVM_StartThread(JNIEnv* env, jobject jthread))
  JavaThread* native_thread = nullptr;
  ...
  ...
  // 실행 시작 → OS 스케줄러에 등록
  Thread::start(native_thread);
JVM_END
```

먼저 `JVM_StartThread`는 함수 마지막에 `Thread::start(natvie_thread);`를 실행한다.

```cpp
// openjdk/src/hotspot/share/runtime/thread.cpp

void Thread::start(Thread* thread) {
  if (thread->is_Java_thread()) {
    // 자바 Thread 상태를 RUNNABLE로 세팅 (자바 관점의 상태)
    java_lang_Thread::set_thread_status(
        JavaThread::cast(thread)->threadObj(),
        JavaThreadStatus::RUNNABLE);
  }
  os::start_thread(thread);
}

```

`Thread::start`는 두 가지를 한다:

1. 자바 `Thread` 객체 상태를 `RUNNABLE` 로 바꾸고
2. `os::start_thread(thread)`를 호출해서 **플랫폼 의존 레이어에 “이제 진짜 실행 시작해도 됨”**이라고 알린다.

### 2-1. `os::start_thread(thread)` – 공통 레이어

```cpp
// openjdk/src/hotspot/share/runtime/os.cpp

void os::start_thread(Thread* thread) {
  OSThread* osthread = thread->osthread();
  osthread->set_state(RUNNABLE);
  pd_start_thread(thread);
}

```

- `osthread = thread->osthread()`

  → `JavaThread`와 연결된 `OSThread`를 가져온다.

- `osthread->set_state(RUNNABLE);`

  → JVM 내부에서 이 스레드는 이제 실행 가능한 상태라고 표시.

- `pd_start_thread(thread);`

  → OS별 구현으로 위임 (Linux라면 `os_linux.cpp`의 `pd_start_thread`).


### 2-2. `os::pd_start_thread(thread)` – Linux 버전

```cpp
// openjdk/src/hotspot/os/linux/os_linux.cpp

void os::pd_start_thread(Thread* thread) {
  OSThread * osthread = thread->osthread();
  assert(osthread->get_state() != INITIALIZED, "just checking");
  Monitor* sync_with_child = osthread->startThread_lock();
  MutexLocker ml(sync_with_child, Mutex::_no_safepoint_check_flag);
  sync_with_child->notify();
}
```

정리하면:

> 기존에 있던 스레드가 새 스레드를 만들면:
>
>
> 기존 스레드 = 부모, 새로 만들어진 스레드 = 자식
>

여기서 일어나는 핵심:

1. `startThread_lock()` 모니터를 가져온다.
2. `MutexLocker`로 잠금을 건다.
3. `notify()`를 호출해서 **자식 스레드를 깨운다.**

즉,

- 자식 스레드는 `startThread_lock` 모니터에서 `wait()` 중이고
- 부모는 `pd_start_thread`에서 `notify()`로 깨운다.

이 부분은 **부모/자식 start barrier 핸드셰이크**의 “부모 쪽 신호”라고 보면 된다.

---

### 누가 부모고, 누가 자식인가?

JVM 입장에서:

- **부모 스레드**

  → `new Thread(...).start()` 를 호출한 쪽.

  → 이미 돌고 있던 자바 스레드(예: `main`), 이 스레드가 내부에서 `JVM_StartThread` → `os::create_thread` → `pthread_create` 를 호출해서 **새 OS 스레드를 만든다**.

- **자식 스레드(child)**

  → `pthread_create` 로 새로 만들어진 OS 스레드.

  → 시작 함수는 `thread_native_entry(Thread* thread)`이고, 이 안에서 `JavaThread::run()` → 최종적으로 자바 `Thread.run()` 을 호출하게 된다.


---

### 실제로는 두 번 핸드셰이크 한다.

조금 더 정확히 말하면, HotSpot은 **부모–자식 사이에서 두 단계로 핸드셰이크**를 한다.

1단계 – `os::create_thread` 안쪽 (Part 3에서 자세하게 다룸)

- 부모가 `pthread_create` 호출
- 자식 OS 스레드가 `thread_native_entry`에 들어온다.
- 자식이 **“나 초기화 끝났어(INITIALIZED)”** 라고 부모에게 알리고(notify),

  부모는 그 신호를 받을 때까지 `ALLOCATED` 상태에서 `wait()`로 잠깐 기다린다.


2단계 – `Thread::start(thread)` / `os::start_thread(thread)`

- 부모 쪽에서 “이제 진짜 실행 시작해도 돼”라는 시점을 잡고,

  `os::start_thread(thread)` → `os::pd_start_thread(thread)` 를 호출

- 자식은 `INITIALIZED` 상태에서 또 한 번 `wait()` 중이고,

  부모가 여기서 `notify()` 를 날려주면 자식이 깨어나서 `thread->call_run()` 으로 들어간다.


`os::pd_start_thread` 코드는 바로 **2단계 – 부모가 자식에게 이제 시작하라고 신호 보내는 부분**이다.

---

## 3. 자식 스레드 입장: thread_native_entry 진입

이제부터는 새로 생성된 **자식 OS 스레드 입장**이다.

(부모가 `pthread_create`로 자식 스레드 생성 후 단계) (위에서 1단계)

```cpp
static void *thread_native_entry(Thread *thread) {
  thread->record_stack_base_and_size();

#ifndef __GLIBC__
  // glibc가 아닌 환경에서 스택 상의 핫 프레임들이
  // 같은 캐시 라인을 계속 두드리는 현상을 줄이기 위한 random alloca trick
  static int counter = 0;
  int pid = os::current_process_id();
  int random = ((pid ^ counter++) & 7) * 128;
  void *stackmem = alloca(random != 0 ? random : 1);
  *(char *)stackmem = 1;
#endif

  thread->initialize_thread_current();

  OSThread* osthread = thread->osthread();
  Monitor* sync = osthread->startThread_lock();

  osthread->set_thread_id(checked_cast<pid_t>(os::current_thread_id()));

  if (UseNUMA) {
    int lgrp_id = os::numa_get_group_id();
    if (lgrp_id != -1) {
      thread->set_lgrp_id(lgrp_id);
    }
  }

  PosixSignals::hotspot_sigmask(thread);
  os::Linux::init_thread_fpu_state();

  {
    MutexLocker ml(sync, Mutex::_no_safepoint_check_flag);

    osthread->set_state(INITIALIZED);
    sync->notify_all();

    while (osthread->get_state() == INITIALIZED) {
      sync->wait_without_safepoint_check();
    }
  }

  log_info(os, thread)("Thread is alive (tid: %zu, pthread id: %zu).",
    os::current_thread_id(), (uintx) pthread_self());

  assert(osthread->pthread_id() != 0, "pthread_id was not set as expected");

  if (DelayThreadStartALot) {
    os::naked_short_sleep(100);
  }

  thread->call_run();

  thread = nullptr;

  log_info(os, thread)("Thread finished (tid: %zu, pthread id: %zu).",
    os::current_thread_id(), (uintx) pthread_self());

  return nullptr;
}

```

### 3-1. 상단부 초기화 (자세히 안보고 넘어가도 된다.)

- `record_stack_base_and_size()`

  → 이 스레드 스택의 시작 주소와 크기를 기록한다.

  나중에 스택 오버플로 감지, 스택 워킹, 샘플링에서 사용된다.

- (glibc가 아닐 때) `alloca`로 약간 랜덤 크기 스택 메모리를 할당

  → 스택 프레임이 항상 같은 캐시 라인에만 몰려서 캐시 eviction이 심해지는 것을 줄이는 트릭.

- `initialize_thread_current()`

  → 이 OS 스레드와 `Thread*` 객체(보통 `JavaThread*`)를 TLS(Thread Local Storage)에 연결.

  이후 `Thread::current()` / `JavaThread::current()`로 자신을 찾을 수 있다.

- `osthread->set_thread_id(...)`

  → OS에서 보는 스레드 ID를 기록.

- NUMA 환경이면 NUMA 그룹 ID 설정.
- `hotspot_sigmask(thread)`

  → 이 스레드의 시그널 마스크를 HotSpot이 기대하는 패턴으로 초기화.

- `init_thread_fpu_state()`

  → FPU/벡터 레지스터 상태(라운딩 모드, 예외 마스크 등) 초기화.


여기까지는 “**OS 스레드를 HotSpot 관리 하에 올려놓기 위한 준비 작업**”이다.

### 3-2. (핵심) 부모와의 start barrier – INITIALIZED ↔ RUNNABLE 전환

```cpp
{
  MutexLocker ml(sync, Mutex::_no_safepoint_check_flag);

  // 1) 자식: "나 INITIALIZED까지 왔어" 상태 알림
  osthread->set_state(INITIALIZED);
  sync->notify_all();

  // 2) 부모가 상태를 바꿔줄 때까지 기다리기
  while (osthread->get_state() == INITIALIZED) {
    sync->wait_without_safepoint_check();
  }
}

```

동작 순서를 정리하면:

1. 자식 스레드는 `startThread_lock` 모니터를 잠근다.
2. 자신의 상태를 `INITIALIZED`로 바꾸고 `notify_all()` 한다.
    - 이 알림은 **부모가 `os::create_thread`에서 기다리던 루프**를 깨우기 위한 것이다.
3. 이후 부모가 `Thread::start` → `os::start_thread` → `pd_start_thread`에서
    - 상태를 `RUNNABLE` 로 바꾸고
    - 같은 모니터에 대해 `notify()`를 쏠 때까지 `wait()`한다.

즉,

- `INITIALIZED`는 “OS 스레드는 만들어졌고, JVM에서 기본 초기화도 끝났지만 **출발 신호는 아직**”이란 뜻.
- 부모가 `osthread->set_state(RUNNABLE)` + `notify()`를 해줘야

  `while (state == INITIALIZED)` 루프를 빠져나가고, 그 다음 코드로 진행할 수 있다.


여기서 **부모/자식 역할 분리**를 정리하면:

- 부모:
    - `JVM_StartThread` 안에서 `new JavaThread` + `os::create_thread` 호출
    - 자식이 `INITIALIZED`까지 왔다는 신호를 받고
    - `Thread::start` → `os::start_thread` → `pd_start_thread`로 최종 “출발” 신호를 보냄
- 자식:
    - `thread_native_entry` 안에서 HotSpot 초기화
    - 자신의 상태를 `INITIALIZED`로 바꾸고 부모에 알림
    - 다시 부모의 “출발” 신호가 올 때까지 초기화 배리어에서 대기

### 3-3. 배리어 통과 후: `thread->call_run()` 호출

배리어를 통과하면:

```cpp
thread->call_run();
```

이 한 줄이 **각 스레드 타입별 run 루틴**으로 들어가는 진입점이다.

- `JavaThread`라면 → `JavaThread::run()` 호출
- `VMThread`, `WatcherThread` 등 다른 종류면 각각의 `run()`이 호출

우리가 보는 건 일반 자바 스레드(`JavaThread`)이므로, `JavaThread::run()`으로 이어진다.

---

## 4. JavaThread::run() – 자바 스레드용 VM 내부 런타임 준비

```cpp
// openjdk/jdk/src/hotspot/share/runtime/javaThread.cpp

void JavaThread::run() {
  initialize_tlab();
  _stack_overflow_state.create_stack_guard_pages();
  cache_global_variables();

  assert(this->thread_state() == _thread_new, "wrong thread state");
  set_thread_state(_thread_in_vm);

  OrderAccess::cross_modify_fence();

  assert(JavaThread::current() == this, "sanity check");
  assert(!Thread::current()->owns_locks(), "sanity check");

  JFR_ONLY(Jfr::on_thread_start(this);)
  DTRACE_THREAD_PROBE(start, this);

  set_active_handles(JNIHandleBlock::allocate_block());

  if (JvmtiExport::should_post_thread_life()) {
    JvmtiExport::post_thread_start(this);
  }

  if (AlwaysPreTouchStacks) {
    pretouch_stack();
  }

  thread_main_inner();
}

```

각 줄이 하는 일을 정리하면:  (자세히 안보고 넘어가도 된다.)

- `initialize_tlab()`

  → 이 스레드 전용 TLAB(Thread-Local Allocation Buffer)을 초기화한다.

  자바에서 `new` 할 때 글로벌 락 없이 자기 TLAB에서 빠르게 할당하기 위함.

- `create_stack_guard_pages()`

  → 스택 끝에 가드 페이지를 설치해 스택 오버플로를 감지한다.

- `cache_global_variables()`

  → 자주 쓰이는 전역 포인터/심볼 등을 스레드 로컬 캐시에 반영.

- `set_thread_state(_thread_in_vm)`

  → 이 스레드는 현재 “VM 코드 안에 있다”는 상태로 전환.

- `cross_modify_fence()`

  → 코드 패치/메모리 재배치 관련해서 강한 장벽을 쳐주는 부분.

- JFR/JVMTI/DTrace 관련 훅

  → 프로파일러/디버거/트레이싱 시스템을 위한 이벤트 발행.

- `set_active_handles(...)`

  → JNI 핸들 블록을 하나 열어, 네이티브에서 GC-safe oop 참조를 할 수 있게 한다.

- `pretouch_stack()` (옵션)

  → 스택 페이지를 미리 만져서 페이지 폴트 지연을 줄이는 기능.


그리고 마지막에: (핵심)

```cpp
thread_main_inner();

```

→ 이제 “진짜로 이 자바 스레드가 무엇을 실행해야 하는지”로 들어가는 핵심 루틴이다.

---

## 5. JavaThread::thread_main_inner() – entry_point 호출 준비

```cpp
void JavaThread::thread_main_inner() {
  assert(JavaThread::current() == this, "sanity check");
  assert(_threadObj.peek() != nullptr, "just checking");

  if (!this->has_pending_exception()) {
    {
      ResourceMark rm(this);
      this->set_native_thread_name(this->name());
    }
    HandleMark hm(this);

    this->entry_point()(this, this);
  }

  DTRACE_THREAD_PROBE(stop, this);
}

```

여기서 중요한 포인트는 세 가지다.

### 5-1. `_threadObj` 확인

- `_threadObj`는 이 `JavaThread`와 연결된 자바 `java.lang.Thread` 인스턴스에 대한 핸들이다.
- `_threadObj.peek() != nullptr` 체크로 “정상적으로 연결되어 있음”을 방어적으로 확인한다.

### 5-2. pending exception 여부 확인

- `has_pending_exception()` 가 `false`일 때만 엔트리 포인트를 호출한다.
- 이유:
    - JVMTI 등의 기능이 스레드 시작 전에 강제로 예외를 걸어둘 수 있다.
    - 그런 경우 `run()`을 호출하지 않고, 예외 처리 루틴으로 넘어가야 하기 때문.

### 5-3. `entry_point` 호출

```cpp
this->entry_point()(this, this);
```

- `entry_point`는 `JavaThread` 생성 시 `set_entry_point(thread_entry)`로 설정해 두었던 함수 포인터.

    ```cpp
    JavaThread::JavaThread(ThreadFunction entry_point, size_t stack_sz, MemTag mem_tag) 
      : JavaThread(mem_tag) {
      set_entry_point(entry_point);
    	...
    }
    
    ```

- 일반 자바 스레드의 경우 `thread_entry(JavaThread*, TRAPS)` 이다.
- 인자를 `(this, this)` 두 개 넘기는 이유:
    - 첫 번째는 `JavaThread* thread` 자체
    - 두 번째는 `TRAPS` (보통 `JavaThread* THREAD`로 매크로 확장) = 예외 컨텍스트

즉, 여기서 드디어:

> thread_entry(this, this);
>

로 **자바 `Thread.run()`을 호출하는 최종 C++ 함수**로 진입한다.

---

## 6. thread_entry – JavaCalls::call_virtual로 Thread.run() 호출

```cpp
static void thread_entry(JavaThread* thread, TRAPS) {
  HandleMark hm(THREAD);

  Handle obj(THREAD, thread->threadObj());

  JavaValue result(T_VOID);

  JavaCalls::call_virtual(&result,
                          obj,
                          vmClasses::Thread_klass(),
                          vmSymbols::run_method_name(),
                          vmSymbols::void_method_signature(),
                          THREAD);
}
```

### `JavaCalls::call_virtual(...)` (핵심)

```cpp
JavaCalls::call_virtual(&result,          // 반환값
                        obj,              // this (자바 Thread 인스턴스)
                        vmClasses::Thread_klass(),            // 선언 클래스
                        vmSymbols::run_method_name(),         // "run"
                        vmSymbols::void_method_signature(),   // "()V"
                        THREAD);          // 예외 컨텍스트

```

C++ 코드(JVM 내부)에서, 자바 객체 `obj`의 `run()` 메서드를 가상 메서드 호출 방식으로 실행하라는 의미이다.

- `&result`

  → 자바 메서드의 반환값을 받아 둘 C++ 쪽 저장소.

  지금은 `void`라 사실상 의미 없음(그냥 형식상 필요).

- `obj`

  → `this`에 해당하는 자바 객체.

  여기서는 `java.lang.Thread`(또는 그 서브클래스) 인스턴스.

- `vmClasses::Thread_klass()`

  → “이 메서드가 **어느 클래스에 선언되어 있다고 보고 찾을지**”를 알려 줌.

  여기선 `Thread` 클래스 기준으로 `run()`을 찾는다는 의미.

- `vmSymbols::run_method_name()` / `vmSymbols::void_method_signature()`

  → 메서드 이름 `"run"` + 시그니처 `"()V"`

  → “인자 없고, void 리턴하는 run()”을 호출하겠다는 뜻.

- `THREAD`

  → 현재 JVM 스레드 컨텍스트(`JavaThread*`)에 대한 예외 처리 정보.

  자바 쪽에서 던진 예외를 여기(pending exception)로 기록해 둔다.


### 이 함수가 내부에서 하는 작업

1. 가상 메서드 해석 (어떤 run()을 호출할지 결정)

이거랑 똑같은 규칙을 적용해서 함수를 찾는다.

- 선언 기준 클래스: `Thread`
- 메서드 이름: `"run"`
- 시그니처: `"()V"`

그래서:

1. `Thread` 클래스에 선언된 `run()`을 기준으로 삼고,
2. 실제 `obj`의 **실제 타입(서브클래스)** 를 따라 올라가면서

   오버라이드된 `run()`이 있으면 그걸 호출한다.


예를 들어:

```cpp
class MyThread extends Thread {
    @Override
    public void run() {
        System.out.println("MyThread run");
    }
}

Thread t = new MyThread();
t.start();
```

이 상황에서 `obj`가 `MyThread` 인스턴스라면,

- `Thread.run()` 이 아니라
- `MyThread.run()`이 실제로 실행되게 메서드를 찾아준다.

즉,

> “자바의 동적 디스패치(virtual call) 를 C++ 쪽에서 그대로 재현”
>

하는 단계라고 보면 된다.

b. **스레드 상태 전환**

- `_thread_in_vm` → `_thread_in_Java`로 바꾸고
- 인터프리터 / JIT 컴파일된 코드 중 적절한 곳으로 점프.

**c.  예외 처리**

- 자바 `run()` 안에서 예외가 던져지면 C++ 예외로 바꾸지 않고
- `THREAD`에 pending exception으로 기록.
- 호출이 끝난 뒤 상위 레벨에서 `THREAD` 상태를 보고

  `uncaughtException` 처리 등으로 넘긴다.


즉 , 이 지점 이후는 그냥 일반적인 자바 실행이다.

즉, `JavaCalls::call_virtual`은:

> “JVM 안에서, 특정 자바 객체의 가상 메서드를 한 번 호출해 주는 브리지”
>

역할을 한다.

---